// NEBCD — build.js
// Reads _data/*.json, renders *.template.html files, writes output HTML.
// Run: node build.js
// GitHub Actions runs this on every push to main.

const fs    = require('fs');
const https = require('https');

// ── Load data ──────────────────────────────────────────────────────────────
const settings    = JSON.parse(fs.readFileSync('_data/settings.json', 'utf8'));
const events      = JSON.parse(fs.readFileSync('_data/events.json', 'utf8')).events;
const endorsements = JSON.parse(fs.readFileSync('_data/endorsements.json', 'utf8')).endorsements;
const storeData   = JSON.parse(fs.readFileSync('_data/store.json', 'utf8'));
const sponsorData = JSON.parse(fs.readFileSync('_data/sponsor.json', 'utf8'));

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

// Build the homepage event preview cards
// CMS featured events take priority; Mobilize fills remaining slots up to 3
function buildEventPreviewCards(mobilizeEvents) {
  const featured = sortedEvents().filter(e => e.featured).slice(0, 3);
  const slotsLeft = 3 - featured.length;

  // CMS cards
  const cmsCards = featured.map(e => `
          <div class="event-card">
            <div class="event-date"><span class="event-month">${esc(formatMonthShort(e.date))}</span><span class="event-day">${formatDay(e.date)}</span></div>
            <div class="event-info">
              <h3>${esc(e.title)}</h3>
              <p class="event-meta">${esc(e.time)} · ${esc(e.location)}</p>
              <p>${esc(e.description)}</p>
              <a href="${e.button_url === '#' ? 'events.html' : esc(e.button_url)}" class="btn-link"${e.button_url !== '#' && e.button_url.startsWith('http') ? ' target="_blank"' : ''}>RSVP / Learn More →</a>
            </div>
          </div>`);

  // Mobilize fill cards (only if slots remain)
  const mobilizeCards = slotsLeft > 0 && mobilizeEvents && mobilizeEvents.length
    ? mobilizeEvents.slice(0, slotsLeft).map(evt => {
        const now       = Math.floor(Date.now() / 1000);
        const slot      = evt.timeslots && (evt.timeslots.find(s => s.start_date >= now) || evt.timeslots[0]);
        const dateObj   = slot ? new Date(slot.start_date * 1000) : null;
        const monthShort = dateObj
          ? dateObj.toLocaleString('en-US', { month: 'short', timeZone: 'America/Chicago' }).toUpperCase()
          : '—';
        const dayNum    = dateObj
          ? dateObj.toLocaleString('en-US', { day: 'numeric', timeZone: 'America/Chicago' })
          : '—';
        const timeStr   = dateObj
          ? dateObj.toLocaleString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago' })
          : '';
        const location  = evt.location
          ? (evt.location.venue || evt.location.locality || 'See Mobilize for details')
          : (evt.is_virtual ? 'Virtual / Online' : 'See Mobilize for details');

        // Strip HTML tags and truncate to ~150 chars
        const rawDesc   = evt.description ? evt.description.replace(/<[^>]+>/g, '').trim() : '';
        const desc      = rawDesc.length > 150 ? rawDesc.slice(0, 147) + '…' : rawDesc;

        return `
          <div class="event-card">
            <div class="event-date"><span class="event-month">${esc(monthShort)}</span><span class="event-day">${esc(dayNum)}</span></div>
            <div class="event-info">
              <h3>${esc(evt.title)}</h3>
              <p class="event-meta">${timeStr ? esc(timeStr) + ' · ' : ''}${esc(location)}</p>
              ${desc ? `<p>${esc(desc)}</p>` : ''}
              <a href="${esc(evt.browser_url)}" target="_blank" class="btn-link">Sign Up on Mobilize →</a>
            </div>
          </div>`;
      })
    : [];

  return [...cmsCards, ...mobilizeCards].join('\n');
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

// Full candidate card for endorsements.html
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

// Build General Election section grouped by race_group
function buildGeneralSection() {
  const general = endorsements.filter(e => e.election === 'general');
  if (!general.length) return '';

  // Group by race_group
  const groups = {};
  general.forEach(e => {
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
        <div class="election-group" id="general">
          <div class="election-group-header">
            <h2>General Election</h2>
          </div>
          ${raceSections}
        </div>`;
}

// Build Primary section grouped by race_group
function buildPrimarySection() {
  const primary = endorsements.filter(e => e.election === 'primary');
  if (!primary.length) return '';

  // Group by race_group
  const groups = {};
  primary.forEach(e => {
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
        <div class="election-group" id="primary">
          <div class="election-group-header">
            <h2>Primary Election</h2>
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

// ── Mobilize helpers ───────────────────────────────────────────────────────

// Fetch upcoming events from Mobilize public API (no key required)
function fetchMobilizeEvents() {
  return new Promise((resolve) => {
    const url = 'https://api.mobilize.us/v1/organizations/50669/events?timeslot_start=gte_now&per_page=5&visibility=PUBLIC';
    https.get(url, { headers: { 'User-Agent': 'NEBCD-build/1.0' } }, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(raw).data || []);
        } catch {
          console.warn('  ⚠ Could not parse Mobilize API response — skipping section.');
          resolve([]);
        }
      });
    }).on('error', (err) => {
      console.warn(`  ⚠ Mobilize API fetch failed (${err.message}) — skipping section.`);
      resolve([]);
    });
  });
}

// Format a Unix timestamp as "Sat, Jun 14 · 10:00 AM"
function formatMobilizeDate(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  return d.toLocaleString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago',
  });
}

// Map Mobilize event_type to NEBCD tag label + CSS class
function mobilizeTagFromTypes(eventType) {
  if (!eventType) return { label: 'Volunteer', cls: 'tag-volunteer' };
  const map = {
    'CANVASS':                    { label: 'Volunteer', cls: 'tag-volunteer' },
    'PHONE_BANK':                 { label: 'Volunteer', cls: 'tag-volunteer' },
    'TEXT_BANK':                  { label: 'Volunteer', cls: 'tag-volunteer' },
    'VOTER_REG':                  { label: 'Volunteer', cls: 'tag-volunteer' },
    'DOOR_KNOCK':                 { label: 'Volunteer', cls: 'tag-volunteer' },
    'COMMUNITY_CANVASS':          { label: 'Volunteer', cls: 'tag-volunteer' },
    'SIGNATURE_GATHERING':        { label: 'Volunteer', cls: 'tag-volunteer' },
    'LETTER_WRITING':             { label: 'Volunteer', cls: 'tag-volunteer' },
    'LITERATURE_DROP_OFF':        { label: 'Volunteer', cls: 'tag-volunteer' },
    'AUTOMATED_PHONE_BANK':       { label: 'Volunteer', cls: 'tag-volunteer' },
    'FRIEND_TO_FRIEND_OUTREACH':  { label: 'Volunteer', cls: 'tag-volunteer' },
    'VOLUNTEER_SHIFT':            { label: 'Volunteer', cls: 'tag-volunteer' },
    'MEETING':                    { label: 'Meeting',   cls: 'tag-meeting'   },
    'TRAINING':                   { label: 'Meeting',   cls: 'tag-meeting'   },
    'TOWN_HALL':                  { label: 'Meeting',   cls: 'tag-meeting'   },
    'WORKSHOP':                   { label: 'Meeting',   cls: 'tag-meeting'   },
    'BARNSTORM':                  { label: 'Meeting',   cls: 'tag-meeting'   },
    'COMMUNITY':                  { label: 'Social',    cls: 'tag-social'    },
    'SOCIAL':                     { label: 'Social',    cls: 'tag-social'    },
    'MEET_GREET':                 { label: 'Social',    cls: 'tag-social'    },
    'HOUSE_PARTY':                { label: 'Social',    cls: 'tag-social'    },
    'FUNDRAISER':                 { label: 'Social',    cls: 'tag-social'    },
    'RALLY':                      { label: 'Social',    cls: 'tag-social'    },
    'DEBATE_WATCH_PARTY':         { label: 'Social',    cls: 'tag-social'    },
    'OFFICE_OPENING':             { label: 'Social',    cls: 'tag-social'    },
    'SOLIDARITY_EVENT':           { label: 'Social',    cls: 'tag-social'    },
    'VISIBILITY_EVENT':           { label: 'Social',    cls: 'tag-social'    },
  };
  return map[eventType] || { label: 'Volunteer', cls: 'tag-volunteer' };
}

// Build the Mobilize events section HTML — reuses existing .event-row markup
function buildMobilizeSection(mobilizeEvents) {
  if (!mobilizeEvents.length) {
    return `
    <section class="mobilize-section">
      <div class="container">
        <h2 class="subsection-title">Volunteer Shifts on Mobilize</h2>
        <p class="mobilize-intro">No upcoming shifts posted yet — check back soon or <a href="https://www.mobilize.us/nebcd/" target="_blank">visit our Mobilize page</a> directly.</p>
      </div>
    </section>`;
  }

  const rows = mobilizeEvents.slice(0, 5).map(evt => {
    const now        = Math.floor(Date.now() / 1000);
    const slot       = evt.timeslots && (evt.timeslots.find(s => s.start_date >= now) || evt.timeslots[0]);
    const startTs    = slot ? slot.start_date : null;
    const dateObj    = startTs ? new Date(startTs * 1000) : null;
    const monthShort = dateObj
      ? dateObj.toLocaleString('en-US', { month: 'short', timeZone: 'America/Chicago' }).toUpperCase()
      : '—';
    const dayNum     = dateObj
      ? dateObj.toLocaleString('en-US', { day: 'numeric', timeZone: 'America/Chicago' })
      : '—';
    const timeStr    = dateObj
      ? dateObj.toLocaleString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago' })
      : '';
    const extraSlots = evt.timeslots && evt.timeslots.length > 1
      ? ` +${evt.timeslots.length - 1} more time${evt.timeslots.length > 2 ? 's' : ''}`
      : '';
    const location   = evt.location
      ? (evt.location.venue || evt.location.locality || 'See Mobilize for details')
      : (evt.is_virtual ? 'Virtual / Online' : 'See Mobilize for details');

    const tag        = mobilizeTagFromTypes(evt.event_type);

    return `
            <div class="event-row">
              <div class="event-row-date"><span class="event-month">${esc(monthShort)}</span><span class="event-day">${esc(dayNum)}</span></div>
              <div class="event-row-body">
                <div class="event-row-header">
                  <h4>${esc(evt.title)}</h4>
                  <span class="event-tag ${tag.cls}">${tag.label}</span>
                </div>
                <p class="event-meta">${timeStr ? esc(timeStr + extraSlots) + ' · ' : ''}${esc(location)}</p>
                <div class="event-row-actions">
                  <a href="${esc(evt.browser_url)}" target="_blank" class="btn btn-blue btn-sm">Sign Up on Mobilize ↗</a>
                </div>
              </div>
            </div>`;
  }).join('\n');

  return `
    <section class="mobilize-section">
      <div class="container">
        <h2 class="subsection-title">Volunteer Shifts on Mobilize</h2>
        <p class="mobilize-intro">Register directly for phonebanks, canvassing days, and other volunteer opportunities. Spots fill up — sign up early.</p>
        <div class="events-list">
          <div class="event-month-group">
            ${rows}
          </div>
        </div>
        <div class="section-footer-link" style="margin-top:1.5rem">
          <a href="https://www.mobilize.us/nebcd/" target="_blank" class="btn btn-outline">View All Shifts on Mobilize ↗</a>
        </div>
      </div>
    </section>`;
}

// ── Fundraiser helpers ─────────────────────────────────────────────────────

// Admin-toggled fundraiser callout, shared by the homepage and Events page.
// Returns '' (nothing rendered) when settings.fundraiser.enabled is false/missing.
function buildFundraiserSection() {
  const f = settings.fundraiser;
  if (!f || !f.enabled) return '';

  const photoHtml = f.photo
    ? `<img src="${esc(f.photo)}" alt="${esc(f.photo_alt || f.headline || '')}" class="fundraiser-photo" loading="lazy" />`
    : '';

  return `
    <!-- FUNDRAISER CALLOUT (admin-toggled via CMS: Site Settings → Fundraiser Callout) -->
    <section class="fundraiser-callout" id="fundraiser">
      <div class="container">
        <div class="fundraiser-card">
          ${photoHtml ? `<div class="fundraiser-photo-col">${photoHtml}</div>` : ''}
          <div class="fundraiser-content-col">
            <span class="eyebrow">${esc(f.eyebrow || 'Fundraiser')}</span>
            <h2>${esc(f.headline)}</h2>
            <p>${esc(f.description)}</p>
            ${f.button_url ? `<a href="${esc(f.button_url)}"${f.button_url.startsWith('http') ? ' target="_blank"' : ''} class="btn btn-blue">${esc(f.button_label || 'Learn More →')}</a>` : ''}
          </div>
        </div>
      </div>
    </section>`;
}

// ── Store helpers ──────────────────────────────────────────────────────────

function buildStoreProductGrid() {
  return storeData.products
    .filter(p => p.available !== false)
    .map(p => `
          <div class="store-item-card">
            <div class="store-item-img-wrap">
              ${p.photo
                ? `<img src="${esc(p.photo)}" alt="${esc(p.name)}" loading="lazy" />`
                : `<div class="store-item-placeholder-img" aria-hidden="true">🛍️</div>`}
            </div>
            <div class="store-item-info">
              <h3>${esc(p.name)}</h3>
              <p>${esc(p.description)}</p>
            </div>
          </div>`).join('\n');
}

// ── Sponsor helpers ────────────────────────────────────────────────────────

function buildSponsorEvents() {
  return sponsorData.events.map((evt, i) => {
    const isAlt = i % 2 !== 0;
    const detailsHtml = [
      evt.date     ? `<div class="sponsor-detail-item"><span class="detail-label">📅 When</span><span class="detail-value">${esc(evt.date)}</span></div>` : '',
      evt.venue    ? `<div class="sponsor-detail-item"><span class="detail-label">📍 Where</span><span class="detail-value">${esc(evt.venue)}</span></div>` : '',
      evt.attendance ? `<div class="sponsor-detail-item"><span class="detail-label">👥 Attendance</span><span class="detail-value">${esc(evt.attendance)}</span></div>` : '',
    ].filter(Boolean).join('\n');

    const tiersHtml = evt.tiers.map(tier => `
              <div class="sponsor-tier">
                <div class="tier-label">${esc(tier.name)}</div>
                <ul class="tier-perks">
                  ${tier.perks.map(p => `<li>${esc(p)}</li>`).join('\n                  ')}
                </ul>
              </div>`).join('\n');

    const photoHtml = evt.photo
      ? `<div class="sponsor-event-photo"><img src="${esc(evt.photo)}" alt="${esc(evt.name)}" loading="lazy" /></div>`
      : '';

    return `
    <section class="sponsor-event-section${isAlt ? ' section-alt' : ''}" id="${esc(evt.id)}">
      <div class="container">
        <div class="sponsor-event-card">
          ${photoHtml}
          <div class="sponsor-event-header">
            <span class="eyebrow">${esc(evt.eyebrow)}</span>
            <h2>${esc(evt.name)}</h2>
            <p class="sponsor-event-desc">${esc(evt.description)}</p>
          </div>
          ${detailsHtml ? `<div class="sponsor-event-details">${detailsHtml}</div>` : ''}
          <div class="sponsor-tiers">
            <h3>Sponsorship Levels</h3>
            <div class="sponsor-tier-grid">
              ${tiersHtml}
            </div>
          </div>
        </div>
      </div>
    </section>`;
  }).join('\n');
}

// ── Main (async to support Mobilize API fetch) ─────────────────────────────
async function main() {

// ── Build endorsements.html ────────────────────────────────────────────────console.log('Building endorsements.html...');
const endorsementsTemplate = fs.readFileSync('endorsements.template.html', 'utf8');
const endorsementsHtml = render(endorsementsTemplate, {
  ENDORSEMENTS_CYCLE_LABEL: esc(settings.endorsements_cycle_label),
  ENDORSEMENTS_INTRO:       esc(settings.endorsements_intro),
  ACTBLUE_DUES_URL:         esc(settings.actblue_dues_url),
  ACTBLUE_DONATE_URL:       esc(settings.actblue_donate_url),
  FACEBOOK_URL:             esc(settings.facebook_url),
  INSTAGRAM_URL:            esc(settings.instagram_url),
  VOTING_RESOURCE_CARDS:    buildVotingResourceCards(),
  GENERAL_SECTION:          buildGeneralSection(),
  PRIMARY_SECTION:          buildPrimarySection(),
  RUNOFF_SECTION:           buildRunoffSection(),
  ENDORSEMENTS_SCHEMA:      buildEndorsementsSchema(),
});
fs.writeFileSync('endorsements.html', endorsementsHtml);
console.log('  ✓ endorsements.html');

// ── Build store.html ───────────────────────────────────────────────────────
console.log('Building store.html...');
const storeTemplate = fs.readFileSync('store.template.html', 'utf8');
const storeHtml = render(storeTemplate, {
  STORE_INTRO:         esc(storeData.store_intro),
  STORE_PRODUCT_GRID:  buildStoreProductGrid(),
  ACTBLUE_DUES_URL:    esc(settings.actblue_dues_url),
  ACTBLUE_DONATE_URL:  esc(settings.actblue_donate_url),
  FACEBOOK_URL:        esc(settings.facebook_url),
  INSTAGRAM_URL:       esc(settings.instagram_url),
});
fs.writeFileSync('store.html', storeHtml);
console.log('  ✓ store.html');

// ── Build sponsor.html ─────────────────────────────────────────────────────
console.log('Building sponsor.html...');
const sponsorTemplate = fs.readFileSync('sponsor.template.html', 'utf8');
const sponsorHtml = render(sponsorTemplate, {
  SPONSOR_INTRO:       esc(sponsorData.sponsor_intro),
  SPONSOR_EVENTS:      buildSponsorEvents(),
  ACTBLUE_DUES_URL:    esc(settings.actblue_dues_url),
  ACTBLUE_DONATE_URL:  esc(settings.actblue_donate_url),
  FACEBOOK_URL:        esc(settings.facebook_url),
  INSTAGRAM_URL:       esc(settings.instagram_url),
});
fs.writeFileSync('sponsor.html', sponsorHtml);
console.log('  ✓ sponsor.html');

// ── Fetch Mobilize events (async) ──────────────────────────────────────────
console.log('Fetching Mobilize events...');
const mobilizeEvents = await fetchMobilizeEvents();
console.log(`  ✓ ${mobilizeEvents.length} Mobilize event(s) fetched`);

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
  EVENT_PREVIEW_CARDS:     buildEventPreviewCards(mobilizeEvents),
  ENDORSEMENT_PREVIEW_CARDS: buildEndorsementPreviewCards(),
  GALLERY_PHOTOS:          buildGalleryPhotos(),
  FUNDRAISER_SECTION:      buildFundraiserSection(),
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
  EVENTS_SCHEMA:           buildEventsSchema(),
  MOBILIZE_SECTION:        buildMobilizeSection(mobilizeEvents),
  FUNDRAISER_SECTION:      buildFundraiserSection(),
});
fs.writeFileSync('events.html', eventsHtml);
console.log('  ✓ events.html');

console.log('\nBuild complete.');

} // end main()

main().catch(err => { console.error('Build failed:', err); process.exit(1); });
