"""Baixa a cota diária do fundo CAIXA Mega DI RF nos Dados Abertos da CVM
e grava em docs/cotas.json. Usa só a biblioteca padrão do Python."""
import csv, io, json, os, re, sys, time, unicodedata, zipfile, urllib.request, urllib.error
from datetime import datetime, timedelta, timezone

CNPJ = "10322633000170"          # CAIXA Mega DI RF (troque aqui se a validação não conferir)
INICIO = (2026, 8)               # primeiro mês a baixar
SAIDA = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "docs", "cotas.json")
URL_MES = "https://dados.cvm.gov.br/dados/FI/DOC/INF_DIARIO/DADOS/inf_diario_fi_{a:04d}{m:02d}.zip"
URL_ANO = "https://dados.cvm.gov.br/dados/FI/DOC/INF_DIARIO/DADOS/HIST/inf_diario_fi_{a:04d}.zip"
# Conferência com o app da CAIXA: R$ 410.000 aplicados em 04/08/2026
CONFERENCIA = ("2026-08-04", 410000.00, {"2026-11-03": 423180.46, "2026-11-04": 423404.38})

BRT = timezone(timedelta(hours=-3))

# Cadastro da CVM: tenta ler se o fundo tem tributação de longo prazo (S/N).
# Os nomes de colunas não foram confirmados; a busca é tolerante e, se falhar,
# a página assume longo prazo (conforme a página da CAIXA para este fundo).
URLS_CAD = [
    ("https://dados.cvm.gov.br/dados/FI/CAD/DADOS/registro_fundo_classe.zip", "zip"),
    ("https://dados.cvm.gov.br/dados/FI/CAD/DADOS/cad_fi.csv", "csv"),
]


def baixar(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (simulador-mega-di)"})
    erro = None
    for tentativa in range(3):
        try:
            with urllib.request.urlopen(req, timeout=180) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            erro = e
        except Exception as e:  # rede instável: tenta de novo
            erro = e
        time.sleep(10 * (tentativa + 1))
    raise RuntimeError(f"Falha ao baixar {url}: {erro}")


def extrair(conteudo_zip):
    """Devolve {data: cota} do CNPJ configurado."""
    achados = {}
    with zipfile.ZipFile(io.BytesIO(conteudo_zip)) as z:
        for nome in z.namelist():
            if not nome.lower().endswith(".csv"):
                continue
            with z.open(nome) as f:
                leitor = csv.reader(io.TextIOWrapper(f, encoding="latin-1", newline=""), delimiter=";")
                cab = [c.strip().upper() for c in next(leitor)]
                i_cnpj = next((i for i, c in enumerate(cab) if c in ("CNPJ_FUNDO_CLASSE", "CNPJ_FUNDO")), None)
                if i_cnpj is None:
                    i_cnpj = next(i for i, c in enumerate(cab) if "CNPJ" in c)
                i_data, i_cota = cab.index("DT_COMPTC"), cab.index("VL_QUOTA")
                i_sub = next((i for i, c in enumerate(cab) if "SUBCLASSE" in c), None)
                for lin in leitor:
                    if len(lin) <= max(i_cnpj, i_data, i_cota):
                        continue
                    if re.sub(r"\D", "", lin[i_cnpj]) != CNPJ:
                        continue
                    data = lin[i_data].strip()[:10]
                    if i_sub is not None and lin[i_sub].strip() and data in achados:
                        continue  # mantém a linha da classe, sem subclasse
                    cota = float(lin[i_cota].replace(",", "."))
                    if cota > 0:
                        achados[data] = cota
    return achados


def _norm(txt):
    return "".join(c for c in unicodedata.normalize("NFKD", txt) if not unicodedata.combining(c)).upper().strip()


def ler_tributacao():
    """Devolve {'longo_prazo': True/False/None, 'fonte': url, 'campo': coluna}. Nunca levanta erro."""
    for url, tipo in URLS_CAD:
        try:
            conteudo = baixar(url)
            if conteudo is None:
                print("  cadastro não encontrado:", url)
                continue
            fontes = []
            if tipo == "zip":
                with zipfile.ZipFile(io.BytesIO(conteudo)) as z:
                    fontes = [(n, z.read(n)) for n in z.namelist() if n.lower().endswith(".csv")]
            else:
                fontes = [(url.rsplit("/", 1)[1], conteudo)]
            for nome, raw in fontes:
                leitor = csv.reader(io.StringIO(raw.decode("latin-1")), delimiter=";")
                cab_orig = [c.strip() for c in next(leitor)]
                cab = [_norm(c) for c in cab_orig]
                i_cnpj = next((i for i, c in enumerate(cab) if "CNPJ" in c), None)
                i_trib = next((i for i, c in enumerate(cab) if re.search(r"TRIB.*(LONGO|LPRAZO)|LONGO.*PRAZO", c)), None)
                if i_cnpj is None or i_trib is None:
                    continue
                valores = set()
                for lin in leitor:
                    if len(lin) <= max(i_cnpj, i_trib) or re.sub(r"\D", "", lin[i_cnpj]) != CNPJ:
                        continue
                    v = _norm(lin[i_trib])
                    if v in ("S", "SIM", "TRUE", "1"):
                        valores.add(True)
                    elif v in ("N", "NAO", "FALSE", "0"):
                        valores.add(False)
                if len(valores) == 1:
                    res = {"longo_prazo": valores.pop(), "fonte": url, "campo": cab_orig[i_trib]}
                    print(f"Tributação CVM: {res['campo']} = {res['longo_prazo']} ({nome})")
                    return res
        except Exception as e:  # cadastro é opcional
            print("  aviso: não foi possível ler o cadastro da CVM:", e)
    print("Tributação CVM: não encontrada; a página assumirá longo prazo.")
    return {"longo_prazo": None, "fonte": None, "campo": None}


def avisos_de_lacuna(cotas):
    datas = sorted(cotas)
    av = []
    for a, b in zip(datas, datas[1:]):
        dias = (datetime.strptime(b, "%Y-%m-%d") - datetime.strptime(a, "%Y-%m-%d")).days
        if dias > 7:
            av.append(f"Há {dias} dias sem cota entre {a[8:]}/{a[5:7]} e {b[8:]}/{b[5:7]}.")
    return av


def meses(de, ate):
    a, m = de
    while (a, m) <= ate:
        yield a, m
        a, m = (a + 1, 1) if m == 12 else (a, m + 1)


def main():
    dados = {"cotas": {}}
    if os.path.exists(SAIDA):
        with open(SAIDA, encoding="utf-8") as f:
            dados = json.load(f)
    cotas = dados.get("cotas", {})

    hoje = datetime.now(BRT)
    if cotas:  # atualização incremental: do mês anterior ao último dado até hoje
        ult = max(cotas)
        a, m = int(ult[:4]), int(ult[5:7])
        de = max((a - 1, 12) if m == 1 else (a, m - 1), INICIO)
    else:
        de = INICIO

    novos = 0
    for a, m in meses(de, (hoje.year, hoje.month)):
        url = URL_MES.format(a=a, m=m)
        print("Baixando", url)
        conteudo = baixar(url)
        if conteudo is None:
            print("  arquivo mensal não encontrado; tentando o anual")
            conteudo = baixar(URL_ANO.format(a=a))
            if conteudo is None:
                print(f"  sem arquivo para {m:02d}/{a}")
                continue
        achados = {d: q for d, q in extrair(conteudo).items() if d.startswith(f"{a:04d}-{m:02d}")}
        print(f"  {len(achados)} cotas do CNPJ em {m:02d}/{a}")
        for d, q in achados.items():
            if cotas.get(d) != q:
                novos += 1
            cotas[d] = q

    if not cotas:
        sys.exit(f"Nenhuma cota encontrada para o CNPJ {CNPJ}. Confira o CNPJ.")

    cotas = dict(sorted(cotas.items()))
    saida = {
        "fundo": "CAIXA Mega DI RF",
        "cnpj": CNPJ,
        "fonte": "CVM - Dados Abertos - Informe Diário",
        "atualizado_em": hoje.strftime("%Y-%m-%d %H:%M"),
        "ultima_data": max(cotas),
        "tributacao": ler_tributacao(),
        "avisos": avisos_de_lacuna(cotas),
        "cotas": cotas,
    }
    for a in saida["avisos"]:
        print("::warning::" + a)
    os.makedirs(os.path.dirname(SAIDA), exist_ok=True)
    with open(SAIDA, "w", encoding="utf-8") as f:
        json.dump(saida, f, ensure_ascii=False, indent=1)
    print(f"OK: {len(cotas)} cotas, última {max(cotas)}, {novos} novas ou alteradas")

    d0, p, refs = CONFERENCIA
    if d0 in cotas:
        for d, app in refs.items():
            if d in cotas:
                calc = p * cotas[d] / cotas[d0]
                status = "CONFERE" if abs(calc - app) < 1 else "NAO CONFERE - verifique o CNPJ"
                print(f"Validação {d}: calculado R$ {calc:,.2f} x app R$ {app:,.2f} -> {status}")


if __name__ == "__main__":
    main()
