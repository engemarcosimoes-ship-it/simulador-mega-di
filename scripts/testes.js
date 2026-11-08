// Testes automáticos do simulador. Rodam no GitHub depois do download das cotas e do CDI.
// Se algum teste falhar, o workflow para ANTES de publicar e o GitHub avisa por e-mail.
// Uso local: node scripts/testes.js [caminho/cotas.json]
const fs = require("fs"), path = require("path");
const raiz = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(raiz, "docs", "index.html"), "utf8");
const m = html.match(/\/\/#CALC-START([\s\S]*?)\/\/#CALC-END/);
if (!m) { console.error("Marcadores //#CALC-START e //#CALC-END não encontrados em docs/index.html"); process.exit(1); }
const E = new Function(m[1] + `
return {setCotas,simular,mensal,agrupar,porAno,cdiFator,compararInvest,ipcaPR,ipcaFim,nextBD,prevBD,numTaxa,numValor,
  proximoCC,autoRate,validDate,REG,CONF,isBD,lastBD,pd,iso,state:()=>({Q,D,LAST,REGIME,CDI,IPCA})};`)();

let ok = 0, falhas = 0;
const t = (nome, cond, det = "") => { if (cond) { ok++; console.log("  ok     " + nome); } else { falhas++; console.log("  FALHA  " + nome + (det ? "  -> " + det : "")); } };
const perto = (a, b, tol) => Math.abs(a - b) <= tol;
const secao = s => console.log("\n" + s);
const lanca = f => { try { f(); return false; } catch (e) { return true; } };

// Série sintética: cota sobe 0,05% por dia útil; CDI de 0,05% ao dia
function serie(ate, extra = {}) {
  const q = {}, cdi = {}; let k = 0; const c = E.pd("2026-08-03"), fim = E.pd(ate);
  while (c <= fim) { if (E.isBD(c)) { q[E.iso(c)] = Math.pow(1.0005, k); cdi[E.iso(c)] = 0.05; k++; } c.setDate(c.getDate() + 1); }
  return Object.assign({ cnpj: "10322633000170", cotas: q, cdi, ipca: { "2026-08": 0.30, "2026-09": 0.45 } }, extra);
}
const P = 410000, ini = "2026-08-04";
const carregar = (j, hoje) => E.setCotas(j, hoje || Object.keys(j.cotas).sort().pop());

secao("Entradas numéricas");
t("taxa 12,5 = 12.5", E.numTaxa("12,5") === 12.5);
t("taxa 12.5 = 12.5 (não vira 125)", E.numTaxa("12.5") === 12.5);
t("taxa inválida: abc, vazio, 1.2.3", [E.numTaxa("abc"), E.numTaxa(""), E.numTaxa("1.2.3")].every(Number.isNaN));
t("valor 410.000,00", E.numValor("410.000,00") === 410000);

secao("Calendário e cotização");
t("sábado 10/10/2026 cotiza em 13/10 (12/10 é feriado)", E.nextBD("2026-10-10") === "2026-10-13");
t("domingo 11/10/2026 usa a cota de sexta 09/10", E.prevBD("2026-10-11") === "2026-10-09");
t("Finados 02/11/2026 cotiza em 03/11", E.nextBD("2026-11-02") === "2026-11-03");
t("primeiro come-cotas depois de 04/11/2026 é 30/11/2026", E.proximoCC("2026-11-04") === "2026-11-30");

secao("Validação das cotas (uma data ruim não derruba o app)");
let v = carregar({ cotas: { "2026-08-03": 1, "2026-08-04": -1, "2026-13-45": 1, "2026-08-08": 1.01, "2026-08-05": "x" } }, "2026-08-10");
t("descarta cota negativa, data inválida, sábado e texto, com aviso", !v.erro && Object.keys(E.state().Q).length === 1 && v.avisos.some(a => a.includes("ignorada")), JSON.stringify(v));
v = carregar({ cotas: { "2026-08-03": 1, "2026-08-04": 1.0005, "2026-12-01": 1.1 } }, "2026-08-10");
t("cota com data futura é descartada", !v.erro && E.state().LAST === "2026-08-04");
t("arquivo só com cotas inválidas é recusado", !!carregar({ cotas: { "2026-08-08": 1 } }, "2026-08-10").erro);
t("CNPJ de outro fundo é recusado", !!carregar({ cnpj: "11111111000111", cotas: { "2026-08-03": 1 } }, "2026-08-10").erro);
t("formato inválido é recusado", !!E.setCotas({}, "2026-08-10").erro && !!E.setCotas(null, "2026-08-10").erro);
v = carregar({ cotas: { "2026-08-03": 1, "2026-08-20": 1.01 } }, "2026-08-20");
t("lacuna de cotas gera aviso", v.avisos.some(a => a.includes("intervalo")));
t("simulação que atravessa a lacuna é bloqueada", lanca(() => E.simular(P, "2026-08-03", "2026-08-20", 0)));
v = carregar({ cotas: { "2026-08-03": 1, "2026-08-04": 1.0005 } }, "2026-09-30");
t("cotas desatualizadas geram aviso", v.avisos.some(a => a.includes("defasadas")));
v = carregar(Object.assign(serie("2026-08-10"), { cdi: { "2026-08-03": -1, "x": 1, "2026-08-04": 0.05, "2026-08-05": 0 } }));
t("CDI inválido ignorado com aviso; taxa zero aceita", v.avisos.some(a => a.includes("Banco Central")) && Object.keys(E.state().CDI).length === 2);

secao("Come-cotas e líquido (série sintética)");
carregar(serie("2027-06-30"));
const cc = E.proximoCC("2026-11-04"), ant = "2026-11-27";
const a1 = E.simular(P, ini, ant, 0), a2 = E.simular(P, ini, cc, 0);
t("come-cotas incide em 30/11", a1.pago === 0 && a2.pago > 0, `pago=${a2.pago.toFixed(2)}`);
t("saldo bruto cai no come-cotas", a2.bruto < a1.bruto);
t("líquido é contínuo no come-cotas (só rende 1 dia)", a2.liq - a1.liq > 0 && a2.liq - a1.liq < P * 0.0006, (a2.liq - a1.liq).toFixed(2));
const b1 = E.simular(P, ini, "2027-01-29", 0), b2 = E.simular(P, ini, "2027-02-01", 0);
t("faixa de IR cai de 22,5% para 20% no dia 181", b1.al === 0.225 && b2.al === 0.20);
t("posição no próprio dia da aplicação não rende", perto(E.simular(P, "2026-10-13", "2026-10-13", 0).bruto, P, 1e-6));
t("aplicação no sábado é cotizada no próximo dia útil", E.simular(P, "2026-10-10", "2026-10-20", 0).entryDate === "2026-10-13");
t("posição anterior à cotização é recusada", lanca(() => E.simular(P, "2026-10-13", "2026-10-11", 0)));
t("capital zero é recusado", lanca(() => E.simular(0, ini, "2026-11-04", 0)));
carregar(serie("2027-06-30", { tributacao: { longo_prazo: false } }));
t("curto prazo: come-cotas de 20% (1,333x o de 15%)", perto(E.simular(P, ini, cc, 0).pago / a2.pago, 20 / 15, 0.01));

secao("Mês a mês e ano a ano fecham com o resultado (com projeção)");
carregar(serie("2026-11-04"));
const dr = E.autoRate();
t("taxa automática calculada", dr !== null && perto(dr, 0.0005, 1e-12), String(dr));
[["2026-08-04", "2026-11-04"], ["2026-08-04", "2026-11-07"], ["2026-08-04", "2027-03-01"], ["2026-08-04", "2029-08-04"], ["2026-10-13", "2026-12-20"]].forEach(([e0, s1]) => {
  const r = E.simular(P, e0, s1, dr), mm = E.mensal(P, e0, s1, dr), ms = E.agrupar(mm.rows);
  const gb = r.bruto + r.pago - P, gl = r.liq - P;
  const sb = ms.reduce((x, y) => x + (y.rb || 0) + (y.pb || 0), 0), sl = ms.reduce((x, y) => x + (y.rl || 0) + (y.pl || 0), 0);
  t(`${e0} a ${s1}: meses somam o bruto`, perto(sb, gb, 0.01), `${sb.toFixed(2)} x ${gb.toFixed(2)}`);
  t(`${e0} a ${s1}: meses somam o líquido`, perto(sl, gl, 0.01), `${sl.toFixed(2)} x ${gl.toFixed(2)}`);
  t(`${e0} a ${s1}: um mês, uma linha`, new Set(ms.map(x => x.y * 100 + x.m)).size === ms.length);
  t(`${e0} a ${s1}: meses depois de novembro só têm projeção`, ms.filter(x => x.y * 100 + x.m > 202611).every(x => x.rb === null && x.pb !== null));
  if (ms.length > 12) {
    const an = E.porAno(ms);
    t(`${e0} a ${s1}: anos somam o líquido`, perto(an.reduce((x, y) => x + (y.rl || 0) + (y.pl || 0), 0), gl, 0.01));
    t(`${e0} a ${s1}: anos 2026 a 2029, 2026 e 2029 parciais`, an.map(x => x.y).join() === "2026,2027,2028,2029" && an[0].partial && an[3].partial && !an[1].partial);
    t(`${e0} a ${s1}: faixa de IR cai em 2027 e 2028`, !!an[1].cut && !!an[2].cut && !an[3].cut);
  }
});


secao("IOF no mês a mês segue a data escolhida");
carregar(serie("2027-06-30"));
{
  const r = E.simular(P, ini, "2026-11-04", 0), mm = E.mensal(P, ini, "2026-11-04", 0);
  const ago = mm.rows[0];
  t("data com 30 dias ou mais: nenhum mês desconta IOF", mm.iofTaxa === 0 && r.iof === 0);
  t("agosto sem IOF: líquido = bruto x (1 - 22,5%)", perto(ago.liq, ago.bruto * 0.775, 0.01), `${ago.liq.toFixed(2)} x ${(ago.bruto * 0.775).toFixed(2)}`);
  const r2 = E.simular(P, ini, "2026-08-25", 0), m2 = E.mensal(P, ini, "2026-08-25", 0);
  t("data com 21 dias: IOF de 30% do rendimento", perto(m2.iofTaxa, 0.30, 1e-12) && r2.iof > 0, String(m2.iofTaxa));
  t("com IOF, o mês a mês soma o líquido do resultado", perto(m2.rows.reduce((a, x) => a + x.liq, 0), r2.liq - P, 0.01));
  const r3 = E.simular(P, "2026-08-20", "2026-09-10", 0), m3 = E.mensal(P, "2026-08-20", "2026-09-10", 0);
  t("21 dias atravessando o mês: mesma taxa de IOF nos dois meses", m3.rows.length === 2 && m3.rows.every(x => perto(x.liq, x.bruto * (1 - 0.30) * 0.775, 0.01)), m3.rows.map(x => [x.bruto.toFixed(2), x.liq.toFixed(2)]).join(" "));
  t("e a soma fecha com o resultado", perto(m3.rows.reduce((a, x) => a + x.liq, 0), r3.liq - P, 0.01));
}

secao("Comparativos (CDI, CDB, LCI/LCA, IPCA)");
carregar(serie("2027-06-30"));
const cfg = { cdb: 100, lci: 90 };
const cp1 = E.compararInvest(P, ini, "2026-11-04", 0, cfg);
t("fundo no mesmo ritmo do CDI rende 100% do CDI", !cp1.erro && perto(cp1.pctCdi, 1, 1e-9), String(cp1.pctCdi));
t("CDB 100% do CDI = fundo no líquido antes do come-cotas", perto(cp1.cdb.ganho, cp1.fundo.ganho, 0.01), `${cp1.cdb.ganho.toFixed(2)} x ${cp1.fundo.ganho.toFixed(2)}`);
t("LCI 90% do CDI: ganho sem IR", perto(cp1.lci.ganho, P * (Math.pow(1 + 0.9 * 0.0005, 63) - 1), 0.01));
const cp2 = E.compararInvest(P, ini, "2027-01-29", 0, cfg);
t("depois do come-cotas o CDB de mesmo bruto rende um pouco mais", cp2.cdb.ganho > cp2.fundo.ganho && cp2.cdb.ganho - cp2.fundo.ganho < cp2.fundo.ganho * 0.005);
t("fundo vs CDI não é distorcido pelo come-cotas", perto(cp2.pctCdi, 1, 1e-9));
const cp3 = E.compararInvest(P, ini, "2026-08-20", 0, cfg);
t("CDB com menos de 30 dias desconta IOF", cp3.cdb.iof > 0);
t("IPCA pro rata de 04/08 a 30/09", perto(E.ipcaPR(ini, "2026-09-30"), Math.pow(1.003, 28 / 31) * 1.0045, 1e-12));
t("IPCA indisponível além do último mês divulgado", E.ipcaPR(ini, "2026-10-15") === null && E.ipcaFim("2026-11-04") === "2026-09-30");
carregar(serie("2026-11-04"));
t("posição futura compara só até a última cota", E.compararInvest(P, ini, "2027-03-01", dr, cfg).end === "2026-11-04");
const furo = serie("2026-11-04"); delete furo.cdi["2026-10-20"]; carregar(furo);
t("CDI com dia faltando: comparativo recusado", !!E.compararInvest(P, ini, "2026-11-04", 0, cfg).erro);
const sem = serie("2026-11-04"); delete sem.cdi; delete sem.ipca; carregar(sem);
t("sem CDI: comparativo indisponível, resto funciona", !!E.compararInvest(P, ini, "2026-11-04", 0, cfg).erro && E.simular(P, ini, "2026-11-04", 0).bruto > P);

secao("Conferência com o app (dados reais)");
const arq = process.argv[2] || path.join(raiz, "docs", "cotas.json");
let real = null;
try { real = JSON.parse(fs.readFileSync(arq, "utf8")); } catch (e) { t("cotas.json legível", false, e.message); }
if (real) {
  const hoje = E.iso(new Date());
  const r = E.setCotas(real, hoje);
  if (r.erro) t("cotas.json com dados válidos", false, r.erro);
  else {
    t("cotas.json válido", true);
    r.avisos.forEach(a => console.log("  aviso: " + a));
    const { Q, CDI, LAST } = E.state();
    E.CONF.refs.forEach(([d, b, l]) => {
      if (!Q[d] || !Q[E.CONF.D0]) { console.log("  pulado: sem cota em " + d + " ou " + E.CONF.D0); return; }
      const s = E.simular(E.CONF.P, E.CONF.D0, d, 0);
      t(`${d}: bruto bate com o app (dif. ${(s.bruto - b).toFixed(2)})`, perto(s.bruto, b, 1));
      t(`${d}: líquido bate com o app (dif. ${(s.liq - l).toFixed(2)})`, perto(s.liq, l, 1));
    });
    if (Object.keys(CDI).length) {
      const c = E.compararInvest(E.CONF.P, E.CONF.D0, LAST, 0, { cdb: 100, lci: 90 });
      if (c.erro) console.log("  aviso: comparativo indisponível com os dados reais: " + c.erro);
      else {
        console.log(`  info: fundo = ${(c.pctCdi * 100).toFixed(1)}% do CDI até ${c.end}`);
        if (c.pctCdi < 0.9 || c.pctCdi > 1.1) console.log("  aviso: percentual do CDI fora de 90% a 110%; confira os índices");
      }
    } else console.log("  aviso: cotas.json ainda sem CDI do Banco Central");
  }
}

console.log(`\n${ok} ok, ${falhas} falha(s)`);
process.exit(falhas ? 1 : 0);
