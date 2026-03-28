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
  routeEventId: null,
  shareBase: null,
};

const EMBED_EVENT = "meeting-overlap";

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

function formatDateTimeInTimezone(dateIso, timeZone) {
  return new Intl.DateTimeFormat("en", {
    timeZone,
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(dateIso));
}

function getDateTimeParts(dateIso, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(
    formatter
      .formatToParts(new Date(dateIso))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value])
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
  };
}

function shiftLocalDateTime(dateValue, timeValue, minutesToAdd) {
  const base = new Date(`${dateValue}T${timeValue}:00`);
  base.setMinutes(base.getMinutes() + minutesToAdd);
  return {
    date: `${base.getFullYear()}-${String(base.getMonth() + 1).padStart(2, "0")}-${String(
      base.getDate()
    ).padStart(2, "0")}`,
    time: `${String(base.getHours()).padStart(2, "0")}:${String(base.getMinutes()).padStart(2, "0")}`,
  };
}

function addDaysToDateString(dateValue, daysToAdd) {
  const [year, month, day] = dateValue.split("-").map(Number);
  const base = new Date(Date.UTC(year, month - 1, day));
  base.setUTCDate(base.getUTCDate() + daysToAdd);
  return `${base.getUTCFullYear()}-${String(base.getUTCMonth() + 1).padStart(2, "0")}-${String(
    base.getUTCDate()
  ).padStart(2, "0")}`;
}

function formatEventLocalDateLabel(dateValue, timeZone) {
  const [year, month, day] = dateValue.split("-").map(Number);
  const safeUtc = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  return new Intl.DateTimeFormat("en", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(safeUtc);
}

function buildQuarterHourOptions(selectedValue = "") {
  const options = [];
  for (let hour = 0; hour < 24; hour += 1) {
    for (let minute = 0; minute < 60; minute += 15) {
      const value = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
      const labelDate = new Date(`2000-01-01T${value}:00Z`);
      const label = new Intl.DateTimeFormat("en", {
        timeZone: "UTC",
        hour: "numeric",
        minute: "2-digit",
      }).format(labelDate);
      options.push(
        `<option value="${value}" ${value === selectedValue ? "selected" : ""}>${escapeHtml(label)}</option>`
      );
    }
  }
  return options.join("");
}

function buildParticipantSlotDefaults(eventData, participantTimezone) {
  const effectiveTimezone = eventData.eventTimezone || participantTimezone || "UTC";
  const start = getDateTimeParts(
    eventData.startUtc || `${eventData.startDate}T00:00:00Z`,
    effectiveTimezone
  );
  const end = shiftLocalDateTime(start.date, start.time, 60);
  return {
    startDate: start.date,
    startTime: start.time,
    endDate: end.date,
    endTime: end.time,
  };
}

function attachDatePickerBehavior(root = document) {
  const dateInputs = root.querySelectorAll('input[type="date"]');
  dateInputs.forEach((input) => {
    if (input.dataset.pickerBound === "true") {
      return;
    }

    input.dataset.pickerBound = "true";
    input.addEventListener("pointerdown", (event) => {
      if (event.pointerType !== "mouse" && event.pointerType !== "touch") {
        return;
      }

      if (typeof input.showPicker !== "function") {
        return;
      }

      event.preventDefault();
      input.focus();
      input.showPicker();
    });
  });
}

function showStatus(message) {
  state.statusMessage = message;
  render();
}

function setStatusBanner(message) {
  state.statusMessage = message;
  const existingBanner = document.querySelector(".status-banner");
  if (existingBanner) {
    existingBanner.textContent = message;
  }
}

function isEmbedded() {
  return window.self !== window.top;
}

function getRouteEventId() {
  const queryEventId = new URLSearchParams(window.location.search).get("event");
  if (queryEventId) {
    return queryEventId;
  }

  if (window.location.pathname.startsWith("/events/")) {
    return window.location.pathname.split("/")[2] || null;
  }

  const hash = window.location.hash.startsWith("#") ? window.location.hash.slice(1) : "";
  const hashParams = new URLSearchParams(hash);
  return hashParams.get("event");
}

function getParentPageBase() {
  if (state.shareBase) {
    return state.shareBase;
  }

  const shareBase = new URLSearchParams(window.location.search).get("shareBase");
  if (shareBase) {
    state.shareBase = shareBase;
    return shareBase;
  }

  if (isEmbedded() && document.referrer) {
    try {
      const referrerUrl = new URL(document.referrer);
      state.shareBase = `${referrerUrl.origin}${referrerUrl.pathname}`;
      return state.shareBase;
    } catch (_error) {
      return null;
    }
  }

  return null;
}

function buildShareUrl(eventId) {
  const parentBase = getParentPageBase();
  if (parentBase) {
    return `${parentBase}?event=${encodeURIComponent(eventId)}`;
  }
  return `${window.location.origin}/events/${encodeURIComponent(eventId)}`;
}

async function copyText(value) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch (_error) {
      // Fallback below for iframe / permissions edge cases.
    }
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  textarea.style.top = "-9999px";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();

  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch (_error) {
    copied = false;
  }

  document.body.removeChild(textarea);
  return copied;
}

function notifyParentNavigation(eventId) {
  if (!isEmbedded()) {
    return;
  }

  window.parent.postMessage(
    {
      type: `${EMBED_EVENT}:navigate`,
      eventId,
      shareUrl: buildShareUrl(eventId),
    },
    "*"
  );
}

function applyEventRoute(eventId) {
  state.routeEventId = eventId;
  if (isEmbedded()) {
    notifyParentNavigation(eventId);
    history.replaceState({ eventId }, "", `/?event=${encodeURIComponent(eventId)}`);
    return;
  }

  history.pushState({ eventId }, "", `/events/${encodeURIComponent(eventId)}`);
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
    startTime: "09:00",
    endTime: "17:00",
  };
}

function renderLanding() {
  appRoot.innerHTML = buildStatusBanner();
  appRoot.appendChild(landingTemplate.content.cloneNode(true));
  attachDatePickerBehavior(appRoot);

  const form = document.querySelector("#create-event-form");
  const defaults = getUpcomingWeekRange();
  form.elements.startDate.value = defaults.startDate;
  form.elements.endDate.value = defaults.endDate;
  form.elements.startTime.value = defaults.startTime;
  form.elements.endTime.value = defaults.endTime;
  document.querySelector("#event-timezone").innerHTML = buildTimezoneOptions(
    Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
  );

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
        startTime: formData.get("startTime"),
        endDate: formData.get("endDate"),
        endTime: formData.get("endTime"),
        eventTimezone: formData.get("eventTimezone"),
      }),
    });
    const payload = await response.json();

    if (!response.ok) {
      showStatus(payload.error || "Unable to create event.");
      return;
    }

    const eventId = payload.event.id;
    state.event = payload.event;
    state.statusMessage = "Event created.";
    applyEventRoute(eventId);
    renderEvent();
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
    <div class="slot-side">
      <label>
        <span>Start date</span>
        <input type="date" name="startDate" value="${escapeHtml(defaults.startDate || "")}" required />
      </label>
      <label>
        <span>Start time</span>
        <select name="startTime" required>
          ${buildQuarterHourOptions(defaults.startTime || "09:00")}
        </select>
      </label>
    </div>
    <div class="slot-side">
      <label>
        <span>End date</span>
        <input type="date" name="endDate" value="${escapeHtml(defaults.endDate || "")}" required />
      </label>
      <label>
        <span>End time</span>
        <select name="endTime" required>
          ${buildQuarterHourOptions(defaults.endTime || "10:00")}
        </select>
      </label>
    </div>
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

  const heatmapTimezone = eventData.eventTimezone || timeZone || "UTC";
  const columns = [];
  let cursorDate = eventData.startDate;
  while (cursorDate <= eventData.endDate) {
    columns.push(formatEventLocalDateLabel(cursorDate, heatmapTimezone));
    cursorDate = addDaysToDateString(cursorDate, 1);
  }

  const slotMap = new Map();
  for (const slot of grid) {
    const dayKey = formatEventLocalDateLabel(
      getDateTimeParts(slot.startUtc, heatmapTimezone).date,
      heatmapTimezone
    );
    const parts = getDateTimeParts(slot.startUtc, heatmapTimezone);
    slotMap.set(`${dayKey}__${parts.time}`, slot);
  }

  const rowTimes = [];
  for (let hour = 0; hour < 24; hour += 1) {
    for (let minute = 0; minute < 60; minute += eventData.summary.slotMinutes) {
      rowTimes.push(`${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`);
    }
  }

  const rowsHtml = rowTimes
    .map((timeKey) => {
      const labelDate = new Date(`2000-01-01T${timeKey}:00Z`);
      const label = new Intl.DateTimeFormat("en", {
        timeZone: "UTC",
        hour: "numeric",
        minute: "2-digit",
      }).format(labelDate);

      const cells = columns
        .map((dayKey) => {
          const slot = slotMap.get(`${dayKey}__${timeKey}`);
          const total = Math.max(eventData.summary.totalParticipants, 1);
          const ratio = slot ? slot.availableCount / total : 0;
          const bg = `rgba(31, 122, 95, ${Math.max(0.04, ratio * 0.95)})`;
          const names = slot?.participantNames?.length
            ? slot.participantNames.join(", ")
            : "No overlap in this slot";
          return `
            <div class="heatmap-cell" style="background:${bg}">
              <strong>${slot ? slot.availableCount : 0}/${eventData.summary.totalParticipants || 0}</strong>
              <div class="heatmap-meta">${escapeHtml(names)}</div>
            </div>
          `;
        })
        .join("");

      return `
        <div class="heatmap-time">${escapeHtml(label)}</div>
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

function wireEventSettingsForm(eventData) {
  const form = document.querySelector("#event-settings-form");
  const timezone = eventData.eventTimezone || "UTC";
  const startParts = getDateTimeParts(
    eventData.startUtc || `${eventData.startDate}T00:00:00Z`,
    timezone
  );
  const endParts = getDateTimeParts(
    eventData.endUtc || `${eventData.endDate}T00:00:00Z`,
    timezone
  );

  form.elements.title.value = eventData.title;
  form.elements.startDate.value = startParts.date;
  form.elements.startTime.value = startParts.time;
  form.elements.endDate.value = endParts.date;
  form.elements.endTime.value = endParts.time;
  document.querySelector("#event-settings-timezone").innerHTML = buildTimezoneOptions(timezone);
  document.querySelector("#event-settings-panel").classList.add("hidden-panel");

  document.querySelector("#edit-event-button").addEventListener("click", () => {
    document.querySelector("#event-settings-panel").classList.toggle("hidden-panel");
  });
  document.querySelector("#cancel-event-edit-button").addEventListener("click", () => {
    document.querySelector("#event-settings-panel").classList.add("hidden-panel");
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const formData = new FormData(form);
    showStatus("Saving event settings...");

    const response = await fetch(`/api/events/${eventData.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: formData.get("title"),
        startDate: formData.get("startDate"),
        startTime: formData.get("startTime"),
        endDate: formData.get("endDate"),
        endTime: formData.get("endTime"),
        eventTimezone: formData.get("eventTimezone"),
      }),
    });

    const payload = await response.json();
    if (!response.ok) {
      showStatus(payload.error || "Unable to update event.");
      return;
    }

    state.event = payload.event;
    state.statusMessage = "Event settings updated.";
    document.querySelector("#event-settings-panel").classList.add("hidden-panel");
    render();
  });
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
  attachDatePickerBehavior(appRoot);

  const eventData = state.event;
  document.querySelector("#event-title").textContent = eventData.title;
  document.querySelector("#event-range").textContent = `${formatDateTimeInTimezone(
    eventData.startUtc || `${eventData.startDate}T00:00:00Z`,
    eventData.eventTimezone || "UTC"
  )} - ${formatDateTimeInTimezone(
    eventData.endUtc || `${eventData.endDate}T00:00:00Z`,
    eventData.eventTimezone || "UTC"
  )}`;
  document.querySelector("#event-timezone-label").textContent = `Event timezone: ${
    eventData.eventTimezone || "UTC"
  }`;
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
    const shareUrl = buildShareUrl(eventData.id);
    const copied = await copyText(shareUrl);
    if (copied) {
      showStatus("Share link copied.");
      return;
    }
    showStatus(`Copy failed. Use this link manually: ${shareUrl}`);
  });

  wireEventSettingsForm(eventData);

  const slotList = document.querySelector("#slot-list");
  const getSelectedParticipantTimezone = () =>
    document.querySelector("#participant-timezone").value ||
    Intl.DateTimeFormat().resolvedOptions().timeZone ||
    "UTC";

  slotList.appendChild(createSlotRow(buildParticipantSlotDefaults(eventData, getSelectedParticipantTimezone())));

  document.querySelector("#add-slot-button").addEventListener("click", () => {
    slotList.appendChild(
      createSlotRow(buildParticipantSlotDefaults(eventData, getSelectedParticipantTimezone()))
    );
  });

  document.querySelector("#participant-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    const rows = Array.from(slotList.querySelectorAll(".slot-row"));
    const slots = rows.map((row) => ({
      startLocal: `${row.querySelector('input[name="startDate"]').value}T${row.querySelector('select[name="startTime"]').value}`,
      endLocal: `${row.querySelector('input[name="endDate"]').value}T${row.querySelector('select[name="endTime"]').value}`,
    }));

    setStatusBanner("Saving availability...");

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
      setStatusBanner(payload.error || "Unable to save availability.");
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
  const eventId = getRouteEventId();
  if (!eventId) {
    renderLanding();
    return;
  }

  appRoot.innerHTML = `<div class="status-banner">Loading event...</div>`;
  try {
    state.routeEventId = eventId;
    state.event = await fetchEvent(eventId);
    renderEvent();
  } catch (error) {
    state.statusMessage = error.message;
    renderLanding();
  }
}

function render() {
  if (state.event && state.routeEventId) {
    renderEvent();
    return;
  }
  renderLanding();
}

window.addEventListener("message", async (event) => {
  if (!event?.data) {
    return;
  }

  if (event.data.type === `${EMBED_EVENT}:context` && event.data.shareBase) {
    state.shareBase = event.data.shareBase;
    return;
  }

  if (event.data.type !== `${EMBED_EVENT}:set-event`) {
    return;
  }

  if (event.data.shareBase) {
    state.shareBase = event.data.shareBase;
  }

  const eventId = event.data.eventId;
  if (!eventId) {
    return;
  }

  history.replaceState({ eventId }, "", `/?event=${encodeURIComponent(eventId)}`);
  state.routeEventId = eventId;
  appRoot.innerHTML = `<div class="status-banner">Loading event...</div>`;
  try {
    state.event = await fetchEvent(eventId);
    renderEvent();
  } catch (error) {
    state.statusMessage = error.message;
    renderLanding();
  }
});

window.addEventListener("popstate", () => {
  state.routeEventId = getRouteEventId();
  renderFromRoute();
});

renderFromRoute();
