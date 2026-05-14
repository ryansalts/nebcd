// NEBCD — build.js
// Reads _data/*.json, renders *.template.html files, writes output HTML.
// Run: node build.js
// GitHub Actions runs this on every push to main.

const fs = require('fs');

// ── Load data ──────────────────────────────────────────────────────────────
const settings    = JSON.parse(fs.readFileSync('_data/settings.json', 'utf8'));
const events      = JSON.parse(fs.readFileSync('_data/events.json', 'utf8')).events;
const endorsements = JSON.parse(fs.readFileSync('_data/endorsements.json', 'utf8')).endorsements;

// ── Helpers ────────────────────────────────────────────────────────────────

// HTML-escape a string
function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Parse a date string like "2026-05-10" into a Date object (local noon to avoid timezone drift)
function parseDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d, 12, 0, 0);
}

// Format date as "MAY" / "10" for event cards
function formatMonthShort(dateStr) {
  const d = parseDate(dateStr);
  return d.toLocaleString('en-US', { month: 'short' }).toUpperCase();
}
function formatDay(dateStr) {
  return parseDate(dateStr).getDate();
}

// Format date as "May 2026" for grouping headers
function formatMonthYear(dateStr) {
  const d = parseDate(dateStr);
  return d.toLocaleString('en-US', { month: 'long', year: 'numeric' });
}

// Event type → CSS tag class
const tagClass = {
  'Meeting':  'tag-meeting',
  'Volunteer': 'tag-volunteer',
  'Social':   'tag-social',
  'Election': 'tag-election',
};

// ── Event helpers ──────────────────────────────────────────────────────────

// Sort events by date ascending
function sortedEvents() {
  return [...events].sort((a, b) => parseDate(a.date) - parseDate(b.date));
}

// Build the homepage event preview cards (featured=true events, max 3)
function buildEventPreviewCards() {
  const featured = sortedEvents().filter(e => e.featured).slice(0, 3);
  return featured.map(e => `
          <div class="event-card">
            <div class="event-date"><span class="event-month">${esc(formatMonthShort(e.date))}</span><span class="event-day">${formatDay(e.date)}</span></div>
            <div class="event-info">
              <h3>${esc(e.title)}</h3>
              <p class="event-meta">${esc(e.time)} · ${esc(e.location)}</p>
              <p>${esc(e.description)}</p>
              <a href="${e.button_url === '#' ? 'events.html' : esc(e.button_url)}" class="btn-link"${e.button_url !== '#' && e.button_url.startsWith('http') ? ' target="_blank"' : ''}>RSVP / Learn More →</a>
            </div>
          </div>`).join('\n');
}

// Build the full event list rows grouped by month (events.html)
function buildEventListRows() {
  const sorted = sortedEvents();
  const groups = {};
  sorted.forEach(e => {
    const key = formatMonthYear(e.date);
    if (!groups[key]) groups[key] = [];
    groups[key].push(e);
  });

  return Object.entries(groups).map(([month, evts]) => {
    const rows = evts.map(e => {
      const isElection = e.type === 'Election';
      return `
            <div class="event-row${isElection ? ' event-row--election' : ''}">
              <div class="event-row-date${isElection ? ' event-row-date--red' : ''}"><span class="event-month">${esc(formatMonthShort(e.date))}</span><span class="event-day">${formatDay(e.date)}</span></div>
              <div class="event-row-body">
                <div class="event-row-header">
                  <h4>${esc(e.title)}</h4>
                  <span class="event-tag ${tagClass[e.type] || ''}">${esc(e.type)}</span>
                </div>
                <p class="event-meta">${esc(e.time)} · ${esc(e.location)}</p>
                <p>${esc(e.description)}</p>
                <div class="event-row-actions">
                  <a href="${esc(e.button_url)}"${e.button_url.startsWith('http') ? ' target="_blank"' : ''} class="btn btn-${isElection ? 'red' : 'blue'} btn-sm">${esc(e.button_label)}</a>
                </div>
              </div>
            </div>`;
    }).join('\n');

    return `
          <div class="event-month-group">
            <h3 class="month-label">${esc(month)}</h3>
            ${rows}
          </div>`;
  }).join('\n');
}

// Build events Schema.org JSON-LD for events.html
function buildEventsSchema() {
  const items = sortedEvents().map((e, i) => {
    const isOnline = e.location.toLowerCase().includes('zoom');
    return {
      '@type': 'Event',
      position: i + 1,
      name: e.title,
      startDate: e.date,
      eventStatus: 'https://schema.org/EventScheduled',
      eventAttendanceMode: isOnline
        ? 'https://schema.org/OnlineEventAttendanceMode'
        : 'https://schema.org/OfflineEventAttendanceMode',
      location: isOnline
        ? { '@type': 'VirtualLocation', url: e.button_url }
        : {
            '@type': 'Place',
            name: 'NEBCD Office',
            address: {
              '@type': 'PostalAddress',
              streetAddress: settings.office_address_street,
              addressLocality: 'San Antonio',
              addressRegion: 'TX',
              postalCode: '78216',
            },
          },
      organizer: {
        '@type': 'Organization',
        name: 'North East Bexar County Democrats',
        url: 'https://www.nebcd.org',
      },
    };
  });

  const schema = {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: 'Upcoming NEBCD Events',
    description: 'Upcoming events from the North East Bexar County Democrats.',
    url: 'https://www.nebcd.org/events',
    itemListElement: items,
  };

  return `<script type="application/ld+json">\n  ${JSON.stringify(schema, null, 2)}\n  <\/script>`;
}

// ── Voting resources ───────────────────────────────────────────────────────
function buildVotingResourceCards() {
  return settings.voting_resources.map(r => `
          <a href="${esc(r.url)}" target="_blank" class="resource-card">
            <div class="resource-icon">${r.icon}</div>
            <h4>${esc(r.title)}</h4>
            <p>${esc(r.description)}</p>
            <span class="btn-link">${esc(r.link_label)}</span>
          </a>`).join('\n');
}

// ── Gallery ────────────────────────────────────────────────────────────────
function buildGalleryPhotos() {
  return settings.gallery_photos.map(p => {
    const sizeClass = p.size === 'tall' ? ' gallery-item--tall' : p.size === 'wide' ? ' gallery-item--wide' : '';
    return `
          <div class="gallery-item${sizeClass}">
            <img src="${esc(p.src)}" alt="${esc(p.alt)}" loading="lazy" />
          </div>`;
  }).join('\n');
}

// ── Endorsement helpers ────────────────────────────────────────────────────

// Homepage endorsement preview cards (featured=true, max 4)
function buildEndorsementPreviewCards() {
  const featured = endorsements.filter(e => e.featured).slice(0, 4);
  return featured.map(e => `
          <div class="endorsement-card">
            ${e.photo ? `<img src="${esc(e.photo)}" alt="${esc(e.name)}" class="candidate-photo" loading="lazy" />` : ''}
            <div class="candidate-info">
              <h4>${esc(e.name)}</h4>
              <p class="candidate-race">${esc(e.office)}${e.race_badge ? ` — ${esc(e.race_badge)}` : ''}</p>
              ${e.campaign_url ? `<a href="${esc(e.campaign_url)}" class="btn-link" target="_blank">${esc(e.campaign_url.replace(/^https?:\/\//, ''))} →</a>` : ''}
            </div>
          </div>`).join('\n');
}

// Full candidate card for endorsements.html (May 2nd candidates)
function buildCandidateCard(e) {
  const socialLinks = [
    e.facebook_url ? `<a href="${esc(e.facebook_url)}" target="_blank" class="social-icon-link" aria-label="Facebook"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M18 2h-3a5 5 0 0 0-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 0 1 1-1h3z"/></svg></a>` : '',
    e.instagram_url ? `<a href="${esc(e.instagram_url)}" target="_blank" class="social-icon-link" aria-label="Instagram"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="20" height="20" rx="5"/><path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z"/><line x1="17.5" y1="6.5" x2="17.51" y2="6.5"/></svg></a>` : '',
  ].filter(Boolean).join('\n                    ');

  return `
              <div class="candidate-card">
                ${e.photo ? `<img src="${esc(e.photo)}" alt="${esc(e.name)}" class="candidate-photo" loading="lazy" />` : ''}
                <div class="candidate-card-body">
                  <div class="candidate-card-header">
                    <h4>${esc(e.name)}</h4>
                    ${e.race_badge ? `<span class="race-badge">${esc(e.race_badge)}</span>` : ''}
                  </div>
                  <p class="candidate-race-label">${esc(e.office)}</p>
                  ${e.co_endorsers ? `<p class="candidate-also-endorsed">Also endorsed by: ${esc(e.co_endorsers)}</p>` : ''}
                  <div class="candidate-links">
                    ${e.campaign_url ? `<a href="${esc(e.campaign_url)}" target="_blank" class="btn btn-blue btn-sm">Campaign Site ↗</a>` : ''}
                    ${socialLinks}
                  </div>
                </div>
              </div>`;
}

// Build May 2nd section grouped by race_group
function buildMay2Section() {
  const may2 = endorsements.filter(e => e.election === 'may2');
  if (!may2.length) return '';

  // Group by race_group
  const groups = {};
  may2.forEach(e => {
    const key = e.race_group || e.office;
    if (!groups[key]) groups[key] = [];
    groups[key].push(e);
  });

  const raceSections = Object.entries(groups).map(([group, candidates]) => `
          <div class="election-race">
            <h3 class="race-label">${esc(group)}</h3>
            <div class="candidate-grid">
              ${candidates.map(buildCandidateCard).join('\n')}
            </div>
          </div>`).join('\n');

  return `
        <div class="election-group" id="may2">
          <div class="election-group-header">
            <h2>May 2nd Election</h2>
          </div>
          ${raceSections}
        </div>`;
}

// Build runoff section
function buildRunoffSection() {
  const runoff = endorsements.filter(e => e.election === 'runoff');
  if (!runoff.length) return '';

  const cards = runoff.map(e => `
            <div class="runoff-card"><h4>${esc(e.name)}</h4><p class="runoff-race">${esc(e.office)}</p></div>`).join('\n');

  return `
        <div class="election-group" id="runoff">
          <div class="election-group-header">
            <h2>Democratic Primary Runoff</h2>
          </div>
          <div class="runoff-grid">
            ${cards}
          </div>
        </div>`;
}

// Build endorsements Schema.org JSON-LD
function buildEndorsementsSchema() {
  const items = endorsements.map((e, i) => {
    const item = {
      '@type': 'Person',
      position: i + 1,
      name: e.name,
      description: `${e.office}${e.race_badge ? `, ${e.race_badge}` : ''}`,
    };
    if (e.campaign_url) item.url = e.campaign_url;
    return item;
  });

  const schema = {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: `NEBCD ${settings.endorsements_cycle_label} Endorsed Candidates`,
    description: `North East Bexar County Democrats endorsements for the ${settings.endorsements_cycle_label} Bexar County elections.`,
    url: 'https://www.nebcd.org/endorsements',
    itemListElement: items,
  };

  return `<script type="application/ld+json">\n  ${JSON.stringify(schema, null, 2)}\n  <\/script>`;
}

// ── Template renderer ──────────────────────────────────────────────────────
function render(template, replacements) {
  let out = template;
  for (const [key, val] of Object.entries(replacements)) {
    out = out.split(`{{${key}}}`).join(val);
  }
  return out;
}

// ── Build index.html ───────────────────────────────────────────────────────
console.log('Building index.html...');
const indexTemplate = fs.readFileSync('index.template.html', 'utf8');
const indexHtml = render(indexTemplate, {
  HERO_IMAGE:              settings.hero_image,
  HERO_IMAGE_ALT:          esc(settings.hero_image_alt),
  VISIT_PHOTO:             settings.visit_photo,
  VISIT_PHOTO_ALT:         esc(settings.visit_photo_alt),
  VISIT_DESCRIPTION:       esc(settings.visit_description),
  OFFICE_ADDRESS_STREET:   esc(settings.office_address_street),
  OFFICE_ADDRESS_CITY:     esc(settings.office_address_city),
  OFFICE_PHONE:            esc(settings.office_phone),
  OFFICE_PHONE_HREF:       esc(settings.office_phone_href),
  OFFICE_EMAIL:            esc(settings.office_email),
  OFFICE_HOURS_LINE1:      esc(settings.office_hours_line1),
  OFFICE_HOURS_LINE2:      esc(settings.office_hours_line2),
  OFFICE_HOURS_LINE3:      esc(settings.office_hours_line3),
  OFFICE_DIRECTIONS_URL:   esc(settings.office_directions_url),
  ACTBLUE_DUES_URL:        esc(settings.actblue_dues_url),
  ACTBLUE_DONATE_URL:      esc(settings.actblue_donate_url),
  FACEBOOK_URL:            esc(settings.facebook_url),
  INSTAGRAM_URL:           esc(settings.instagram_url),
  ENDORSEMENTS_INTRO:      esc(settings.endorsements_intro),
  EVENT_PREVIEW_CARDS:     buildEventPreviewCards(),
  ENDORSEMENT_PREVIEW_CARDS: buildEndorsementPreviewCards(),
  GALLERY_PHOTOS:          buildGalleryPhotos(),
});
fs.writeFileSync('index.html', indexHtml);
console.log('  ✓ index.html');

// ── Build events.html ──────────────────────────────────────────────────────
console.log('Building events.html...');
const eventsTemplate = fs.readFileSync('events.template.html', 'utf8');
const eventsHtml = render(eventsTemplate, {
  ACTBLUE_DUES_URL:        esc(settings.actblue_dues_url),
  ACTBLUE_DONATE_URL:      esc(settings.actblue_donate_url),
  FACEBOOK_URL:            esc(settings.facebook_url),
  INSTAGRAM_URL:           esc(settings.instagram_url),
  EVENT_LIST_ROWS:         buildEventListRows(),
  VOTING_RESOURCE_CARDS:   buildVotingResourceCards(),
  EVENTS_SCHEMA:           buildEventsSchema(),
});
fs.writeFileSync('events.html', eventsHtml);
console.log('  ✓ events.html');

// ── Build endorsements.html ────────────────────────────────────────────────
console.log('Building endorsements.html...');
const endorsementsTemplate = fs.readFileSync('endorsements.template.html', 'utf8');
const endorsementsHtml = render(endorsementsTemplate, {
  ENDORSEMENTS_CYCLE_LABEL: esc(settings.endorsements_cycle_label),
  ENDORSEMENTS_INTRO:       esc(settings.endorsements_intro),
  ACTBLUE_DUES_URL:         esc(settings.actblue_dues_url),
  ACTBLUE_DONATE_URL:       esc(settings.actblue_donate_url),
  FACEBOOK_URL:             esc(settings.facebook_url),
  INSTAGRAM_URL:            esc(settings.instagram_url),
  MAY2_SECTION:             buildMay2Section(),
  RUNOFF_SECTION:           buildRunoffSection(),
  ENDORSEMENTS_SCHEMA:      buildEndorsementsSchema(),
});
fs.writeFileSync('endorsements.html', endorsementsHtml);
console.log('  ✓ endorsements.html');

console.log('\nBuild complete.');
