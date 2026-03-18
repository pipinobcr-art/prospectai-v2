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
const APP_URL       = process.env.APP_URL || 'https://prospectai-xgie.onrender.com';

if (!ANTHROPIC_KEY) console.warn('⚠️  ANTHROPIC_API_KEY manquante');
if (!MOLLIE_KEY)    console.warn('⚠️  MOLLIE_API_KEY manquante');

// ── AI Writer ──────────────────────────────────────────
app.post('/api/ai/generate-email', async (req, res) => {
  const { name, company, tone, lang, prop } = req.body;
  if (!name || !company) return res.status(400).json({ error: 'Champs manquants' });

  const prompt = lang === 'fr'
    ? `Écris un email de prospection court (max 5 phrases) en français, ton ${tone}, pour ${name} chez ${company}. Valeur proposée: "${prop}". Email percutant, personnalisé, CTA clair. Format: Objet: [objet]\n\n[corps]`
    : `Write a short cold email (max 5 sentences), ${tone} tone, for ${name} at ${company}. Value prop: "${prop}". Compelling, personalised, clear CTA. Format: Subject: [subject]\n\n[body]`;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    const d = await r.json();
    if (d.error) return res.status(400).json({ error: d.error.message });
    res.json({ email: d.content.map(b => b.text || '').join('') });
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur Anthropic' });
  }
});

// ── Mollie — Créer paiement ────────────────────────────
const PLAN_PRICES = {
  starter_monthly: { amount: '29.00',   label: 'ProspectAI Starter — Mensuel' },
  starter_annual:  { amount: '228.00',  label: 'ProspectAI Starter — Annuel'  },
  pro_monthly:     { amount: '79.00',   label: 'ProspectAI Pro — Mensuel'     },
  pro_annual:      { amount: '636.00',  label: 'ProspectAI Pro — Annuel'      },
  agency_monthly:  { amount: '199.00',  label: 'ProspectAI Agency — Mensuel'  },
  agency_annual:   { amount: '1596.00', label: 'ProspectAI Agency — Annuel'   },
};

app.post('/api/mollie/create-payment', async (req, res) => {
  const { planKey, customerEmail, planName, credits } = req.body;
  const plan = PLAN_PRICES[planKey];
  if (!plan) return res.status(400).json({ error: 'Plan invalide: ' + planKey });

  try {
    const r = await fetch('https://api.mollie.com/v2/payments', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${MOLLIE_KEY}`
      },
      body: JSON.stringify({
        amount:      { currency: 'EUR', value: plan.amount },
        description: plan.label,
        redirectUrl: `${APP_URL}/?id={payment.id}&email=${encodeURIComponent(customerEmail)}&plan=${encodeURIComponent(planName)}&credits=${credits}`,
        webhookUrl:  `${APP_URL}/api/mollie/webhook`,
        metadata:    { planKey, customerEmail, planName, credits: String(credits) }
      })
    });
    const d = await r.json();
    if (d._links?.checkout?.href) {
      res.json({ checkoutUrl: d._links.checkout.href, paymentId: d.id });
    } else {
      res.status(400).json({ error: d.detail || d.message || 'Erreur Mollie' });
    }
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur Mollie' });
  }
});

// ── Mollie — Webhook ───────────────────────────────────
app.post('/api/mollie/webhook', async (req, res) => {
  const { id } = req.body;
  try {
    const r = await fetch(`https://api.mollie.com/v2/payments/${id}`, {
      headers: { 'Authorization': `Bearer ${MOLLIE_KEY}` }
    });
    const p = await r.json();
    if (p.status === 'paid') {
      console.log(`✅ PAIEMENT: ${p.metadata?.customerEmail} → ${p.metadata?.planKey}`);
    }
    res.sendStatus(200);
  } catch (e) {
    res.sendStatus(500);
  }
});

// ── Mollie — Vérifier paiement ─────────────────────────
app.get('/api/mollie/payment/:id', async (req, res) => {
  try {
    const r = await fetch(`https://api.mollie.com/v2/payments/${req.params.id}`, {
      headers: { 'Authorization': `Bearer ${MOLLIE_KEY}` }
    });
    const d = await r.json();
    res.json({
      status:   d.status,
      planKey:  d.metadata?.planKey,
      planName: d.metadata?.planName,
      credits:  parseInt(d.metadata?.credits || '0'),
      email:    d.metadata?.customerEmail
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Health check ───────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ── Start ──────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 ProspectAI → port ${PORT}`);
});
