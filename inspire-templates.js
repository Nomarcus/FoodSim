/*
 * A synthetic estate of 500 document templates, in the shape an Inspire
 * Designer shop would have: many customers, many document types, each with its
 * own workflow - data input, mapping, scripts, layout, objects, outputs.
 *
 * Nothing here is a real customer or a real WFD file. WFD is Quadient's own
 * format; a real setup would export each workflow and reduce it to a summary
 * like `describe()` below before anything is asked. `toXml()` is an
 * illustration of that export, not its schema.
 *
 * The estate is generated from a fixed seed, so every visitor sees the same
 * 500 templates. The preset questions each have a hand-written answer key -
 * which templates they are about - and the generator plants exactly those and
 * re-rolls anything else that would accidentally match. That key is used to
 * mark the wall after Jev has answered. It is never sent.
 */
(function (global) {
  'use strict';

  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = seed + 0x6D2B79F5 | 0;
      let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  const CUSTOMERS = [
    'Älvbanken', 'Kraftbolaget Öst', 'Trygga Försäkringar', 'Hemhyran', 'Atlas Telecom',
    'Vattenverket Syd', 'Medica Vård', 'Fjällby kommun', 'Lönia', 'Bilfinans Norr',
    'Solvik Energi', 'Granit Bygg', 'Havsbris Resor', 'Lindqvist Juridik', 'Polar Pension',
    'Stadsparken Fastigheter', 'Nova Försäkring', 'Bergby El', 'Kustbanken', 'Vinterhamn'
  ];

  const DOCS = [
    { key: 'invoice',   name: 'Faktura' },
    { key: 'reminder',  name: 'Påminnelse' },
    { key: 'policy',    name: 'Försäkringsbrev' },
    { key: 'welcome',   name: 'Välkomstpaket' },
    { key: 'statement', name: 'Kontoutdrag' },
    { key: 'contract',  name: 'Avtal' },
    { key: 'payslip',   name: 'Lönebesked' },
    { key: 'renewal',   name: 'Förnyelsebrev' },
    { key: 'claim',     name: 'Skadebesked' },
    { key: 'annual',    name: 'Årsbesked' }
  ];

  const LANGS = ['sv', 'en', 'fi', 'no', 'da', 'de'];
  const CHANNELS = ['print', 'pdf', 'email', 'sms', 'archive'];
  const FORMATS = ['XML', 'CSV', 'JSON', 'fixed-width'];
  const SOURCES = ['SAP', 'Hyressystem 2', 'Kärnsystem', 'CRM', 'Lönesystem L7', 'Försäkringskärnan',
                   'Mätdatabas', 'Kundportal', 'Ekonomi 360'];
  const TEAMS = ['CCM-team Nord', 'CCM-team Syd', 'Leveransteam', 'Kundteam B2B'];

  /* Where a change lands in a workflow. Jev picks one of these. */
  const AREAS = [
    { key: 'data',      name: 'Data input & mapping',  criteria: 'The change is about what data comes in or how it is mapped: a new file format, a new source system, new or renamed fields.' },
    { key: 'script',    name: 'Scripts & rules',       criteria: 'The change is about business logic: conditions, calculations, rules written as scripts.' },
    { key: 'layout',    name: 'Layout & content',      criteria: 'The change is about what is on the page: text, sections, pages, logos, the look of the document.' },
    { key: 'objects',   name: 'Barcodes, QR & charts', criteria: 'The change is about a generated object on the page: a barcode, a QR code, a chart or graph.' },
    { key: 'channels',  name: 'Output channels',       criteria: 'The change is about how the document is delivered: print, PDF, email, SMS, archive.' },
    { key: 'languages', name: 'Languages',             criteria: 'The change is about which languages the document exists in, or its translations.' }
  ];

  const INTENTS = {
    setup:  'The customer wants to know how their current setup looks: which template, what goes in, what comes out.',
    change: 'The customer wants to know whether a change can be made to something they already have.',
    effort: 'The customer wants to know how long or how much work a change would take.',
    which:  'The customer wants a list of which templates have some property.'
  };

  /* Size of a change, as score levels from smallest to largest. */
  const EFFORT = [
    'A setting or a piece of text in one place. Under an hour.',
    'A small change inside one module. About half a day.',
    'Several modules, or new data mapping and testing. One to three days.',
    'A new structure or a rebuild of the workflow. A week or more.'
  ];
  const EFFORT_BANDS = ['under an hour', 'about half a day', '1–3 days', 'a week or more'];

  const pick = (r, list) => list[Math.floor(r() * list.length)];
  function subset(r, list, min, max, must) {
    const out = new Set(must || []);
    const n = min + Math.floor(r() * (max - min + 1));
    while (out.size < n) out.add(pick(r, list));
    return list.filter(x => out.has(x));
  }

  function build(r, spec) {
    spec = spec || {};
    const doc = spec.doc || pick(r, DOCS).key;
    const t = {
      customer: spec.customer || pick(r, CUSTOMERS),
      doc,
      segment: spec.segment || (r() < 0.6 ? 'privat' : 'företag'),
      langs: spec.langs || subset(r, LANGS, 1, 3, ['sv']),
      channels: spec.channels || subset(r, CHANNELS, 1, 3),
      format: spec.format || pick(r, FORMATS),
      source: spec.source || pick(r, SOURCES),
      scripted: spec.scripted != null ? spec.scripted : r() < 0.35,
      barcode: spec.barcode != null ? spec.barcode : r() < 0.4,
      chart: spec.chart != null ? spec.chart : (doc === 'statement' || doc === 'annual') && r() < 0.7,
      pages: spec.pages || 1 + Math.floor(r() * (doc === 'contract' || doc === 'welcome' ? 12 : 4)),
      variables: 8 + Math.floor(r() * 140),
      changed: '2026-' + String(1 + Math.floor(r() * 10)).padStart(2, '0') + '-' +
               String(1 + Math.floor(r() * 28)).padStart(2, '0'),
      team: pick(r, TEAMS)
    };
    t.sorted = t.channels.includes('print') && r() < 0.5;
    return t;
  }

  /*
   * Preset questions with their answer keys. `gold` decides which templates a
   * question is about; `plant` lists the templates that must exist for it.
   */
  const PRESETS = [
    {
      text: 'Hur ser vår setup ut för Älvbankens e-faktura till privatkunder på svenska?',
      intent: 'setup',
      gold: t => t.customer === 'Älvbanken' && t.doc === 'invoice' && t.segment === 'privat' &&
                 t.langs.includes('sv') && t.channels.includes('email'),
      plant: [{ customer: 'Älvbanken', doc: 'invoice', segment: 'privat', langs: ['sv'], channels: ['email', 'archive'] }],
      decoys: [{ customer: 'Älvbanken', doc: 'invoice', segment: 'företag', channels: ['print', 'pdf'] },
               { customer: 'Älvbanken', doc: 'reminder', segment: 'privat', channels: ['email'] }]
    },
    {
      text: 'Kan vi lägga till en QR-kod för betalning på Kraftbolaget Östs pappersfakturor?',
      intent: 'change',
      gold: t => t.customer === 'Kraftbolaget Öst' && t.doc === 'invoice' && t.channels.includes('print'),
      plant: [{ customer: 'Kraftbolaget Öst', doc: 'invoice', segment: 'privat', channels: ['print', 'archive'], barcode: false },
              { customer: 'Kraftbolaget Öst', doc: 'invoice', segment: 'företag', channels: ['print', 'pdf'], barcode: true }],
      decoys: [{ customer: 'Kraftbolaget Öst', doc: 'invoice', segment: 'privat', channels: ['email'] },
               { customer: 'Kraftbolaget Öst', doc: 'annual', channels: ['print'] }]
    },
    {
      text: 'Hur lång tid skulle det ta att lägga till finska i Trygga Försäkringars förnyelsebrev?',
      intent: 'effort',
      gold: t => t.customer === 'Trygga Försäkringar' && t.doc === 'renewal',
      plant: [{ customer: 'Trygga Försäkringar', doc: 'renewal', langs: ['sv', 'en'], channels: ['print', 'email'] }],
      decoys: [{ customer: 'Trygga Försäkringar', doc: 'policy', langs: ['sv', 'fi'] },
               { customer: 'Nova Försäkring', doc: 'renewal', langs: ['sv'] }]
    },
    {
      text: 'Kan Hemhyrans påminnelser ta JSON från det nya hyressystemet i stället för CSV?',
      intent: 'change',
      gold: t => t.customer === 'Hemhyran' && t.doc === 'reminder',
      plant: [{ customer: 'Hemhyran', doc: 'reminder', format: 'CSV', source: 'Hyressystem 2', channels: ['print'] },
              { customer: 'Hemhyran', doc: 'reminder', format: 'CSV', source: 'Hyressystem 2', channels: ['email', 'sms'] }],
      decoys: [{ customer: 'Hemhyran', doc: 'invoice', format: 'CSV', source: 'Hyressystem 2' },
               { customer: 'Stadsparken Fastigheter', doc: 'reminder', format: 'CSV' }]
    },
    {
      text: 'Vilka av Lönias lönebesked bygger fortfarande på egna skript?',
      intent: 'which',
      gold: t => t.customer === 'Lönia' && t.doc === 'payslip' && t.scripted,
      plant: [{ customer: 'Lönia', doc: 'payslip', scripted: true, segment: 'företag' },
              { customer: 'Lönia', doc: 'payslip', scripted: true, segment: 'privat' },
              { customer: 'Lönia', doc: 'payslip', scripted: true, langs: ['sv', 'en'] }],
      decoys: [{ customer: 'Lönia', doc: 'payslip', scripted: false },
               { customer: 'Lönia', doc: 'payslip', scripted: false, langs: ['sv', 'fi'] },
               { customer: 'Lönia', doc: 'annual', scripted: true }]
    },
    {
      text: 'Kan Atlas Telecoms välkomstpaket skickas som sms också?',
      intent: 'change',
      gold: t => t.customer === 'Atlas Telecom' && t.doc === 'welcome',
      plant: [{ customer: 'Atlas Telecom', doc: 'welcome', channels: ['print', 'email'], pages: 8 }],
      decoys: [{ customer: 'Atlas Telecom', doc: 'invoice', channels: ['sms', 'email'] },
               { customer: 'Atlas Telecom', doc: 'contract', channels: ['pdf'] }]
    }
  ];

  function generate(count) {
    count = count || 500;
    const r = mulberry32(20261106);
    const list = [];

    // Planted answers first, then their decoys - near misses that share the
    // customer or the document type, which is what makes the question hard.
    // A decoy is checked against every key too: one that accidentally matches
    // would quietly make the key wrong.
    PRESETS.forEach(p => p.plant.forEach(spec => list.push(build(r, spec))));
    PRESETS.forEach(p => p.decoys.forEach(spec => {
      let t, tries = 0;
      do { t = build(r, spec); tries++; } while (PRESETS.some(q => q.gold(t)) && tries < 200);
      if (!PRESETS.some(q => q.gold(t))) list.push(t);
    }));

    while (list.length < count) {
      const t = build(r);
      if (PRESETS.some(p => p.gold(t))) continue;
      list.push(t);
    }

    // Shuffle so the planted ones are not sitting at the front, then order by
    // document type so the wall groups them.
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
    const order = DOCS.map(d => d.key);
    list.sort((a, b) => order.indexOf(a.doc) - order.indexOf(b.doc));
    list.forEach((t, i) => {
      t.id = 'T-' + String(i + 1).padStart(4, '0');
      t.name = t.customer + ' – ' + DOCS.find(d => d.key === t.doc).name +
               ' (' + t.segment + ', ' + t.langs.join('/') + ')';
    });
    return list;
  }

  function modules(t) {
    const m = [{ area: 'data', type: 'DataInput', label: t.format + ' from ' + t.source }];
    m.push({ area: 'data', type: 'DataTransformer', label: t.variables + ' variables mapped' });
    if (t.scripted) m.push({ area: 'script', type: 'Script', label: 'custom rules script' });
    m.push({ area: 'layout', type: 'Layout', label: t.pages + (t.pages === 1 ? ' page' : ' pages') });
    m.push({ area: 'languages', type: 'Languages', label: t.langs.join(', ') });
    if (t.barcode) m.push({ area: 'objects', type: 'Barcode', label: 'barcode' });
    if (t.chart) m.push({ area: 'objects', type: 'Chart', label: 'chart' });
    if (t.sorted) m.push({ area: 'channels', type: 'Sorter', label: 'postal sort' });
    t.channels.forEach(c => m.push({ area: 'channels', type: 'Output', label: c }));
    return m;
  }

  /* The one-line summary the model is shown. Everything a question could be
   * about is in here, and nothing that would give the answer key away. */
  function describe(t) {
    const doc = DOCS.find(d => d.key === t.doc).name;
    return [
      t.id, t.customer, doc, 'segment ' + t.segment,
      'languages ' + t.langs.join('/'),
      'outputs ' + t.channels.join('/'),
      'input ' + t.format + ' from ' + t.source,
      t.scripted ? 'has custom script' : 'no custom script',
      t.barcode ? 'has barcode' : 'no barcode',
      t.chart ? 'has chart' : '',
      t.pages + ' pages'
    ].filter(Boolean).join('; ');
  }

  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }
  function toXml(t) {
    const lines = ['<Workflow id="' + t.id + '" name="' + esc(t.name) + '" owner="' + esc(t.team) +
                   '" changed="' + t.changed + '">'];
    lines.push('  <DataInput format="' + t.format + '" source="' + esc(t.source) + '"/>');
    lines.push('  <DataTransformer variables="' + t.variables + '"/>');
    if (t.scripted) lines.push('  <Script name="rules_' + t.id.slice(2) + '.js"/>');
    lines.push('  <Layout pages="' + t.pages + '" segment="' + t.segment + '">');
    t.langs.forEach(l => lines.push('    <Language code="' + l + '"/>'));
    if (t.barcode) lines.push('    <Barcode type="Code128"/>');
    if (t.chart) lines.push('    <Chart type="bar"/>');
    lines.push('  </Layout>');
    if (t.sorted) lines.push('  <Sorter type="postal"/>');
    t.channels.forEach(c => lines.push('  <Output channel="' + c + '"/>'));
    lines.push('</Workflow>');
    return lines.join('\n');
  }

  global.InspireTemplates = {
    generate, describe, toXml, modules,
    DOCS, AREAS, INTENTS, EFFORT, EFFORT_BANDS, PRESETS
  };
})(window);
