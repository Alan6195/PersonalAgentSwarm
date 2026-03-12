// Debug: check why markets fail hard filters
async function check() {
  const terms = ['bitcoin price', 'BTC', 'crypto', 'OpenAI', 'AI model release'];
  const now = Date.now();

  for (const term of terms) {
    const res = await fetch(`https://api.manifold.markets/v0/search-markets?term=${encodeURIComponent(term)}&sort=score&limit=10`);
    const markets = await res.json();

    for (const m of markets.slice(0, 5)) {
      if (m.outcomeType !== 'BINARY') continue;
      if (!m.closeTime) continue;

      const days = (new Date(m.closeTime).getTime() - now) / (1000 * 60 * 60 * 24);
      const prob = m.probability || 0.5;
      const bettors = m.uniqueBettorCount || 0;
      const resolved = m.isResolved;

      let fail = [];
      if (resolved !== false) fail.push('resolved');
      if (days < 0) fail.push('expired');
      if (days > 7) fail.push('days>' + days.toFixed(0));
      if (prob < 0.15 || prob > 0.85) fail.push('prob=' + prob.toFixed(2));
      if (bettors < 20) fail.push('bettors=' + bettors);

      const status = fail.length === 0 ? 'PASS' : 'FAIL(' + fail.join(',') + ')';
      console.log(`[${term}] ${status} | days=${days.toFixed(1)} prob=${prob.toFixed(2)} bettors=${bettors} | ${m.question.substring(0, 70)}`);
    }
  }
}

check().catch(console.error);
