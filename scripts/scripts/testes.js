// Testes automáticos do simulador. Rodam no GitHub depois do download das cotas.
// Se algum teste falhar, o workflow para ANTES de publicar e você recebe e-mail do GitHub.
// Uso local: node scripts/testes.js [caminho/cotas.json]
const fs = require("fs"), path = require("path");
const raiz = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(raiz, "docs", "index.html"), "utf8");
const m = html.match(/\/\/#CALC-START([\s\S]*?)\/\/#CALC-END/);
if (!m) { console.error("Marcadores CALC-START/CALC-END não encontrados em docs/index.html"); process.exit(1); }
const E = new Function(m[1] + `
return {setCotas,simular,mensal,nextBD,numTaxa,numValor,proximoCC,autoRate,REG,CONF,isBD,lastBD,pd,iso,state:()=>({Q,D,LAST,REGIME})};`)();

let ok = 0, falhas = 0;
const t = (nome, cond, det = "") => { if (cond) { ok++; console.log("  ok     " + nome); } else { falhas++; console.log("  FALHA  " + nome + (det ? "  -> " + det : "")); } };
const perto = (a, b, tol) => Math.abs(a - b) <= tol;
const secao = s => console.log("\n" + s);

// Série sintética: um dia útil por vez, 0,05% ao dia
function serie(ate, extra = {}) {
  const q = {}; let k = 0; const c = E.pd("2026-08-03"), fim = E.pd(ate);
  while (c <= fim) { if (E.isBD(c)) { q[E.iso(c)] = Math.pow(1.0005, k); k++; } c.setDate(c.getDate() + 1); }
  return Object.assign({ cotas: q }, extra);
}
const P = 410000, ini = "2026-08-04";

secao("Entradas numéricas");
t("taxa 12,5 = 12.5", E.numTaxa("12,5") === 12.5);
t("taxa 12.5 = 12.5 (não vira 125)", E.numTaxa("12.5") === 12.5);
t("taxa 13,7244", E.numTaxa("13,7244") === 13.7244);
t("taxa inválida: abc, vazio, 1.2.3, 1,5,2", [E.numTaxa("abc"), E.numTaxa(""), E.numTaxa("1.2.3"), E.numTaxa("1,5,2")].every(Number.isNaN));
t("valor 410.000,00", E.numValor("410.000,00") === 410000);
t("valor inválido vira NaN", Number.isNaN(E.numValor("abc")));

secao("Calendário e cotização");
t("sábado 10/10/2026 cotiza em 13/10 (12/10 é feriado)", E.nextBD("2026-10-10") === "2026-10-13");
t("dia útil permanece", E.nextBD("2026-10-09") === "2026-10-09");
t("feriado de Finados 02/11/2026 cotiza em 03/11", E.nextBD("2026-11-02") === "2026-11-03");
t("primeiro come-cotas depois de 04/11/2026 é 30/11/2026", E.proximoCC("2026-11-04") === "2026-11-30");

secao("Validação das cotas");
let v = E.setCotas({ cotas: { "2026-08-03": 1, "2026-08-04": -1, "2026-13-45": 1, "2026-08-05": "x" } });
t("ignora datas e cotas inválidas", v.avisos.length >= 3 && Object.keys(E.state().Q).length === 1, JSON.stringify(v.avisos));
v = E.setCotas({ cotas: { "2026-08-03": 1, "2026-08-20": 1.01 } });
t("acusa lacuna de dias sem cota", v.avisos.some(a => a.includes("sem cota")));
v = E.setCotas({ cotas: { "2026-08-03": 1, "2026-08-04": 1.05 } });
t("acusa salto diário acima de 1%", v.avisos.some(a => a.includes("Variação")));
v = E.setCotas({ cotas: { "2026-08-03": 1, "2026-08-04": 1.0005 } }, "2026-09-30");
t("acusa cotas desatualizadas", v.avisos.some(a => a.includes("atualização automática")));
t("formato inválido é recusado", !!E.setCotas({}).erro && !!E.setCotas(null).erro);

secao("Come-cotas e líquido (série sintética)");
E.setCotas(serie("2027-06-30"));
const cc = E.proximoCC("2026-11-04"), ant = "2026-11-27";
const a1 = E.simular(P, ini, ant, 0), a2 = E.simular(P, ini, cc, 0);
t("come-cotas incide em 30/11", a1.pago === 0 && a2.pago > 0, `pago=${a2.pago.toFixed(2)}`);
t("saldo bruto cai no come-cotas", a2.bruto < a1.bruto);
t("líquido é contínuo no come-cotas (só rende 1 dia)", a2.liq - a1.liq > 0 && a2.liq - a1.liq < P * 0.0006, (a2.liq - a1.liq).toFixed(2));
const b1 = E.simular(P, ini, "2027-01-29", 0), b2 = E.simular(P, ini, "2027-02-01", 0);
t("faixa de IR muda de 22,5% para 20% no dia 181", b1.al === 0.225 && b2.al === 0.20, `${b1.dc}d=${b1.al} ${b2.dc}d=${b2.al}`);
E.setCotas(serie("2027-06-30", { tributacao: { longo_prazo: false } }));
const cp = E.simular(P, ini, cc, 0);
t("curto prazo: come-cotas de 20% (1,333x o de 15%)", perto(cp.pago / a2.pago, 20 / 15, 0.01), (cp.pago / a2.pago).toFixed(4));
E.setCotas(serie("2027-06-30"));
const same = E.simular(P, "2026-10-13", "2026-10-13", 0);
t("posição no próprio dia da aplicação não rende", perto(same.bruto, P, 1e-6));

secao("Tabela mensal fecha com o resultado (com projeção)");
E.setCotas(serie("2026-11-04"));
const dr = E.autoRate();
[["2026-08-04", "2026-11-04"], ["2026-08-04", "2026-11-07"], ["2026-08-04", "2027-03-01"], ["2026-09-15", "2027-02-01"], ["2026-10-13", "2026-10-30"]].forEach(([e0, s1]) => {
  const r = E.simular(P, e0, s1, dr), mm = E.mensal(P, e0, s1, dr);
  const sb = mm.rows.reduce((x, y) => x + y.bruto, 0), sl = mm.rows.reduce((x, y) => x + y.liq, 0);
  t(`${e0} a ${s1}: soma do bruto = card`, perto(sb, r.bruto + r.pago - P, 0.01), `${sb.toFixed(2)} x ${(r.bruto + r.pago - P).toFixed(2)}`);
  t(`${e0} a ${s1}: soma do líquido = card (sem IOF)`, perto(sl, r.liqSemIof - P, 0.01));
  t(`${e0} a ${s1}: projeção só depois da última cota`, mm.rows.every(x => x.proj === (x.start >= "2026-11-04")));
});

secao("Conferência com o app (dados reais)");
const arq = process.argv[2] || path.join(raiz, "docs", "cotas.json");
let real = null;
try { real = JSON.parse(fs.readFileSync(arq, "utf8")); } catch (e) { t("cotas.json legível", false, e.message); }
if (real) {
  const r = E.setCotas(real);
  if (r.erro) { t("cotas.json com dados", false, r.erro); }
  else {
    t("cotas.json válido", true);
    r.avisos.forEach(a => console.log("  aviso: " + a));
    const { Q } = E.state();
    E.CONF.refs.forEach(([d, b, l]) => {
      if (!Q[d] || !Q[E.CONF.D0]) { console.log("  pulado: sem cota em " + d + " ou " + E.CONF.D0); return; }
      const s = E.simular(E.CONF.P, E.CONF.D0, d, 0);
      t(`${d}: bruto bate com o app (dif. ${(s.bruto - b).toFixed(2)})`, perto(s.bruto, b, 1));
      t(`${d}: líquido bate com o app (dif. ${(s.liq - l).toFixed(2)})`, perto(s.liq, l, 1));
    });
  }
}

console.log(`\n${ok} ok, ${falhas} falha(s)`);
process.exit(falhas ? 1 : 0);
