const appRoot = document.querySelector("#app");
const landingTemplate = document.querySelector("#landing-template");
const eventTemplate = document.querySelector("#event-template");

const defaultTimezones = [
  "UTC",
  "America/Vancouver",
  "America/New_York",
  "Europe/London",
  "Europe/Berlin",
  "Asia/Dubai",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Australia/Sydney",
];

const state = {
  event: null,
  displayTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  statusMessage: "",
};

function getSupportedTimezones() {
  if (typeof Intl.supportedValuesOf === "function") {
    return Intl.supportedValuesOf("timeZone");
  }
  return defaultTimezones;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatRange(startIso, endIso, timeZone) {
  const start = new Date(startIso);
  const end = new Date(endIso);
  const dateFormatter = new Intl.DateTimeFormat("en", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  return `${dateFormatter.format(start)} - ${dateFormatter.format(end)}`;
}

function formatDateOnly(dateIso) {
  return new Date(`${dateIso}T00:00:00`).toLocaleDateString("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function showStatus(message) {
  state.statusMessage = message;
  render();
}

function buildStatusBanner() {
  if (!state.statusMessage) {
    return "";
  }
  return `<div class="status-banner">${escapeHtml(state.statusMessage)}</div>`;
}

function getUpcomingWeekRange() {
  const today = new Date();
  const currentDay = today.getDay();
  const daysUntilMonday = currentDay === 0 ? 1 : 8 - currentDay;
  const start = new Date(today);
  start.setDate(today.getDate() + daysUntilMonday);
  const end = new Date(start);
  end.setDate(start.getDate() + 6);

  return {
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
  };
}

function renderLanding() {
  appRoot.innerHTML = buildStatusBanner();
  appRoot.appendChild(landingTemplate.content.cloneNode(true));

  const form = document.querySelector("#create-event-form");
  const defaults = getUpcomingWeekRange();
  form.elements.startDate.value = defaults.startDate;
  form.elements.endDate.value = defaults.endDate;

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const formData = new FormData(form);
    showStatus("Creating event...");

    const response = await fetch("/api/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: formData.get("title"),
        startDate: formData.get("startDate"),
        endDate: formData.get("endDate"),
      }),
    });
    const payload = await response.json();

    if (!response.ok) {
      showStatus(payload.error || "Unable to create event.");
      return;
    }

    const eventId = payload.event.id;
    window.location.href = `/events/${eventId}`;
  });
}

function buildTimezoneOptions(selectedTimezone) {
  return getSupportedTimezones()
    .map(
      (timezone) =>
        `<option value="${escapeHtml(timezone)}" ${
          timezone === selectedTimezone ? "selected" : ""
        }>${escapeHtml(timezone)}</option>`
    )
    .join("");
}

function createSlotRow(defaults = {}) {
  const row = document.createElement("div");
  row.className = "slot-row";
  row.innerHTML = `
    <label>
      <span>Start</span>
      <input type="datetime-local" name="startLocal" value="${escapeHtml(defaults.startLocal || "")}" required />
    </label>
    <label>
      <span>End</span>
      <input type="datetime-local" name="endLocal" value="${escapeHtml(defaults.endLocal || "")}" required />
    </label>
    <button type="button" class="remove-button">Remove</button>
  `;
  row.querySelector(".remove-button").addEventListener("click", () => row.remove());
  return row;
}

function buildHeatmap(eventData, timeZone) {
  const grid = eventData.summary.grid;
  if (!grid.length) {
    return `<div class="empty-state">No slots available yet.</div>`;
  }

  const dayFormatter = new Intl.DateTimeFormat("en", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  const timeFormatter = new Intl.DateTimeFormat("en", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
  });

  const columns = [];
  const byTime = new Map();

  for (const slot of grid) {
    const start = new Date(slot.startUtc);
    const dayKey = dayFormatter.format(start);
    const timeKey = timeFormatter.format(start);

    if (!columns.includes(dayKey)) {
      columns.push(dayKey);
    }
    if (!byTime.has(timeKey)) {
      byTime.set(timeKey, {});
    }
    byTime.get(timeKey)[dayKey] = slot;
  }

  const rowsHtml = Array.from(byTime.entries())
    .map(([timeKey, dayMap]) => {
      const cells = columns
        .map((dayKey) => {
          const slot = dayMap[dayKey];
          if (!slot) {
            return `<div class="heatmap-cell"></div>`;
          }
          const total = Math.max(eventData.summary.totalParticipants, 1);
          const ratio = slot.availableCount / total;
          const bg = `rgba(31, 122, 95, ${Math.max(0.08, ratio * 0.95)})`;
          const names = slot.participantNames.length
            ? slot.participantNames.join(", ")
            : "Nobody yet";
          return `
            <div class="heatmap-cell" style="background:${bg}">
              <strong>${slot.availableCount}/${eventData.summary.totalParticipants || 0}</strong>
              <div class="heatmap-meta">${escapeHtml(names)}</div>
            </div>
          `;
        })
        .join("");

      return `
        <div class="heatmap-time">${escapeHtml(timeKey)}</div>
        ${cells}
      `;
    })
    .join("");

  const headerHtml = columns
    .map((column) => `<div class="heatmap-head">${escapeHtml(column)}</div>`)
    .join("");

  return `
    <div class="heatmap-grid" style="--heatmap-columns:${columns.length}">
      <div class="heatmap-head">Time</div>
      ${headerHtml}
      ${rowsHtml}
    </div>
  `;
}

function buildBestSlots(eventData, timeZone) {
  const bestSlots = eventData.summary.bestSlots;
  if (!bestSlots.length) {
    return `<div class="empty-state">Add participants to see overlap recommendations.</div>`;
  }

  return bestSlots
    .map(
      (slot) => `
        <article class="best-slot-card">
          <strong>${escapeHtml(formatRange(slot.startUtc, slot.endUtc, timeZone))}</strong>
          <span class="muted">${slot.availableCount}/${eventData.summary.totalParticipants} participants available</span>
          <div class="heatmap-meta">${escapeHtml(slot.participantNames.join(", "))}</div>
        </article>
      `
    )
    .join("");
}

function buildParticipantList(eventData, timeZone) {
  if (!eventData.participants.length) {
    return `<div class="empty-state">No one has added availability yet.</div>`;
  }

  return eventData.participants
    .map((participant) => {
      const firstSlot = participant.slots[0];
      const preview = firstSlot
        ? formatRange(firstSlot.startUtc, firstSlot.endUtc, timeZone)
        : "No slots submitted";
      return `
        <article class="participant-pill">
          <strong>${escapeHtml(participant.name)}</strong>
          <span class="muted">${escapeHtml(participant.timezone)}</span>
          <div class="heatmap-meta">${escapeHtml(preview)}</div>
        </article>
      `;
    })
    .join("");
}

function renderEvent() {
  appRoot.innerHTML = buildStatusBanner();
  appRoot.appendChild(eventTemplate.content.cloneNode(true));

  const eventData = state.event;
  document.querySelector("#event-title").textContent = eventData.title;
  document.querySelector("#event-range").textContent = `${formatDateOnly(
    eventData.startDate
  )} - ${formatDateOnly(eventData.endDate)}`;
  document.querySelector("#participant-count").textContent = `${eventData.participants.length} participant(s)`;

  const participantTimezoneSelect = document.querySelector("#participant-timezone");
  participantTimezoneSelect.innerHTML = buildTimezoneOptions(
    Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
  );

  const displayTimezoneSelect = document.querySelector("#display-timezone");
  displayTimezoneSelect.innerHTML = buildTimezoneOptions(state.displayTimezone);
  displayTimezoneSelect.addEventListener("change", (event) => {
    state.displayTimezone = event.target.value;
    render();
  });

  document.querySelector("#participant-list").innerHTML = buildParticipantList(
    eventData,
    state.displayTimezone
  );
  document.querySelector("#best-slots").innerHTML = buildBestSlots(
    eventData,
    state.displayTimezone
  );
  document.querySelector("#heatmap").innerHTML = buildHeatmap(
    eventData,
    state.displayTimezone
  );

  document.querySelector("#copy-link-button").addEventListener("click", async () => {
    await navigator.clipboard.writeText(window.location.href);
    showStatus("Share link copied.");
  });

  const slotList = document.querySelector("#slot-list");
  slotList.appendChild(createSlotRow());

  document.querySelector("#add-slot-button").addEventListener("click", () => {
    slotList.appendChild(createSlotRow());
  });

  document.querySelector("#participant-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    const rows = Array.from(slotList.querySelectorAll(".slot-row"));
    const slots = rows.map((row) => ({
      startLocal: row.querySelector('input[name="startLocal"]').value,
      endLocal: row.querySelector('input[name="endLocal"]').value,
    }));

    showStatus("Saving availability...");

    const response = await fetch(`/api/events/${eventData.id}/participants`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: formData.get("name"),
        timezone: formData.get("timezone"),
        slots,
      }),
    });

    const payload = await response.json();
    if (!response.ok) {
      showStatus(payload.error || "Unable to save availability.");
      return;
    }

    state.event = payload.event;
    state.statusMessage = "Availability saved.";
    render();
  });
}

async function fetchEvent(eventId) {
  const response = await fetch(`/api/events/${eventId}`);
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || "Unable to load event.");
  }
  return payload.event;
}

async function renderFromRoute() {
  const path = window.location.pathname;
  if (path === "/") {
    renderLanding();
    return;
  }

  if (path.startsWith("/events/")) {
    appRoot.innerHTML = `<div class="status-banner">Loading event...</div>`;
    try {
      const eventId = path.split("/")[2];
      state.event = await fetchEvent(eventId);
      renderEvent();
    } catch (error) {
      state.statusMessage = error.message;
      renderLanding();
    }
    return;
  }

  renderLanding();
}

function render() {
  if (state.event && window.location.pathname.startsWith("/events/")) {
    renderEvent();
    return;
  }
  renderLanding();
}

renderFromRoute();
