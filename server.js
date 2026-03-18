const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');
const path    = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const MOLLIE_KEY    = process.env.MOLLIE_API_KEY;
const APOLLO_KEY    = process.env.APOLLO_API_KEY || '6y3G2ASyfAWc7FKGmshnXA';
const APP_URL       = process.env.APP_URL || 'https://prospectai-v2.onrender.com';

// ─────────────────────────────────────────
//  APOLLO — Recherche vraies personnes
// ─────────────────────────────────────────
app.post('/api/apollo/search', async (req, res) => {
  const { title, industry, company_size, location, seniority, technology, page = 1, per_page = 10 } = req.body;

  const body = { api_key: APOLLO_KEY, page, per_page };

  if (title)    body.q_keywords = title;
  if (location) body.person_locations = [location];
  if (seniority) {
    const senMap = { 'VP / Directeur': 'vp', 'C-Level': 'c_suite', 'Manager': 'manager', 'Individuel': 'individual_contributor' };
    if (senMap[seniority]) body.person_seniorities = [senMap[seniority]];
  }
  if (technology) body.q_organization_keyword_tags = [technology];
  if (company_size) {
    const sizeMap = { '1 à 10': ['1,10'], '11 à 50': ['11,50'], '51 à 200': ['51,200'], '201 à 500': ['201,500'], '500+': ['501,10000'] };
    if (sizeMap[company_size]) body.organization_num_employees_ranges = sizeMap[company_size];
  }

  try {
    const response = await fetch('https://api.apollo.io/v1/mixed_people/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
      body: JSON.stringify(body)
    });
    const data = await response.json();

    if (!data.people) return res.status(400).json({ error: data.message || 'Erreur Apollo' });

    const prospects = data.people.map(p => ({
      id:       p.id,
      name:     p.name || `${p.first_name||''} ${p.last_name||''}`.trim(),
      title:    p.title || '—',
      company:  p.organization?.name || '—',
      size:     p.organization?.num_employees ? formatSize(p.organization.num_employees) : '—',
      location: [p.city, p.country].filter(Boolean).join(', ') || '—',
      email:    p.email || null,
      linkedin: p.linkedin_url || null,
      score:    getScore(p),
      avatar:   getInitials(p.name || `${p.first_name} ${p.last_name}`),
      photo:    p.photo_url || null,
    }));

    res.json({
      prospects,
      total:       data.pagination?.total_entries || prospects.length,
      page:        data.pagination?.page || 1,
      total_pages: data.pagination?.total_pages || 1,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────
//  APOLLO — Enrichissement
// ─────────────────────────────────────────
app.post('/api/apollo/enrich', async (req, res) => {
  const { person_id } = req.body;
  if (!person_id) return res.status(400).json({ error: 'person_id requis' });
  try {
    const r = await fetch('https://api.apollo.io/v1/people/match', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: APOLLO_KEY, id: person_id })
    });
    const d = await r.json();
    if (!d.person) return res.status(400).json({ error: 'Introuvable' });
    res.json({
      email:    d.person.email || 'Non disponible',
      phone:    d.person.phone_numbers?.[0]?.sanitized_number || 'Non disponible',
      linkedin: d.person.linkedin_url || null,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

function formatSize(n) {
  if (n<=10) return '1–10'; if (n<=50) return '11–50';
  if (n<=200) return '51–200'; if (n<=500) return '201–500';
  if (n<=1000) return '501–1000'; return '1000+';
}
function getScore(p) {
  let s=0;
  if(p.email) s+=3; if(p.linkedin_url) s+=2;
  if(p.phone_numbers?.length) s+=2; if(p.organization?.name) s+=1; if(p.title) s+=1;
  return s>=7?'hot':s>=4?'warm':'cold';
}
function getInitials(name) {
  if(!name) return '??';
  return name.split(' ').map(w=>w[0]).join('').toUpperCase().slice(0,2);
}

// ─────────────────────────────────────────
//  ANTHROPIC — AI Writer
// ─────────────────────────────────────────
app.post('/api/ai/generate-email', async (req, res) => {
  const { name, company, tone, lang, prop } = req.body;
  if (!name || !company) return res.status(400).json({ error: 'Champs manquants' });

  const prompt = lang === 'fr'
    ? `Écris un email de prospection court (max 5 phrases) en français, ton ${tone}, pour ${name} chez ${company}. Valeur proposée: "${prop}". Email percutant, personnalisé, CTA clair. Format: Objet: [objet]\n\n[corps]`
    : `Write a short cold email (max 5 sentences), ${tone} tone, for ${name} at ${company}. Value prop: "${prop}". Compelling, personalised, clear CTA. Format: Subject: [subject]\n\n[body]`;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 1000, messages: [{ role: 'user', content: prompt }] })
    });
    const d = await r.json();
    if (d.error) return res.status(400).json({ error: d.error.message });
    res.json({ email: d.content.map(b => b.text || '').join('') });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────
//  MOLLIE — Paiements
// ─────────────────────────────────────────
const PLAN_PRICES = {
  starter_monthly: { amount: '29.00',   label: 'IAProspectAI Starter — Mensuel' },
  starter_annual:  { amount: '228.00',  label: 'IAProspectAI Starter — Annuel'  },
  pro_monthly:     { amount: '79.00',   label: 'IAProspectAI Pro — Mensuel'     },
  pro_annual:      { amount: '636.00',  label: 'IAProspectAI Pro — Annuel'      },
  agency_monthly:  { amount: '199.00',  label: 'IAProspectAI Agency — Mensuel'  },
  agency_annual:   { amount: '1596.00', label: 'IAProspectAI Agency — Annuel'   },
};

app.post('/api/mollie/create-payment', async (req, res) => {
  const { planKey, customerEmail, planName, credits } = req.body;
  const plan = PLAN_PRICES[planKey];
  if (!plan) return res.status(400).json({ error: 'Plan invalide' });
  try {
    const r = await fetch('https://api.mollie.com/v2/payments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${MOLLIE_KEY}` },
      body: JSON.stringify({
        amount: { currency: 'EUR', value: plan.amount },
        description: plan.label,
        redirectUrl: `${APP_URL}/?id={payment.id}&email=${encodeURIComponent(customerEmail)}&plan=${encodeURIComponent(planName)}&credits=${credits}`,
        webhookUrl:  `${APP_URL}/api/mollie/webhook`,
        metadata:    { planKey, customerEmail, planName, credits: String(credits) }
      })
    });
    const d = await r.json();
    if (d._links?.checkout?.href) res.json({ checkoutUrl: d._links.checkout.href, paymentId: d.id });
    else res.status(400).json({ error: d.detail || 'Erreur Mollie' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/mollie/webhook', async (req, res) => {
  const { id } = req.body;
  try {
    const r = await fetch(`https://api.mollie.com/v2/payments/${id}`, { headers: { 'Authorization': `Bearer ${MOLLIE_KEY}` } });
    const p = await r.json();
    if (p.status === 'paid') console.log(`✅ PAIEMENT: ${p.metadata?.customerEmail} → ${p.metadata?.planKey}`);
    res.sendStatus(200);
  } catch { res.sendStatus(500); }
});

app.get('/api/mollie/payment/:id', async (req, res) => {
  try {
    const r = await fetch(`https://api.mollie.com/v2/payments/${req.params.id}`, { headers: { 'Authorization': `Bearer ${MOLLIE_KEY}` } });
    const d = await r.json();
    res.json({ status: d.status, planKey: d.metadata?.planKey, planName: d.metadata?.planName, credits: parseInt(d.metadata?.credits||'0'), email: d.metadata?.customerEmail });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/health', (req, res) => res.json({ status: 'ok', apollo: !!APOLLO_KEY, anthropic: !!ANTHROPIC_KEY, mollie: !!MOLLIE_KEY }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 IAProspectAI PRO → port ${PORT}`);
  console.log(`   Apollo:    ${APOLLO_KEY    ? '✅' : '❌'}`);
  console.log(`   Anthropic: ${ANTHROPIC_KEY ? '✅' : '❌'}`);
  console.log(`   Mollie:    ${MOLLIE_KEY    ? '✅' : '❌'}`);
});
