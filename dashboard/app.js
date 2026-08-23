// Set DEFAULT_API_BASE to your remote backend URL (e.g. "https://your-aria-bot.com") when deploying on GitHub Pages.
// Leave as empty string "" when running locally or on the same domain as the backend.
const DEFAULT_API_BASE = "https://aria-fdyw.onrender.com";

const $ = selector => document.querySelector(selector);
const apiBaseKey = "aria-api-base";
const guildId = "demo";

const params = new URLSearchParams(location.search);
const queryApi = params.get("api");

if (queryApi) {
  localStorage.setItem(apiBaseKey, queryApi);
}
if (queryApi) {
  params.delete("api");
  const newQuery = params.toString() ? `?${params.toString()}` : "";
  history.replaceState({}, "", `${location.pathname}${newQuery}`);
}

const getApiBase = () => (localStorage.getItem(apiBaseKey) || DEFAULT_API_BASE).replace(/\/$/, "");
const api = async (path, options = {}) => {
  const url = `${getApiBase()}${path}`;
  const response = await fetch(url, {
    ...options,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...options.headers
    }
  });
  if (!response.ok) {
    let message = response.statusText;
    try {
      const err = await response.json();
      if (err.error) message = err.error;
    } catch {}
    throw new Error(message);
  }
  return response.json();
};

const contrast = hex => {
  const [r, g, b] = hex.match(/[a-f\d]{2}/gi).map(x => parseInt(x, 16) / 255).map(x => x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.42 ? "#171522" : "#ffffff";
};

function theme(name, value) {
  document.documentElement.style.setProperty(`--${name}`, value);
  document.documentElement.style.setProperty(`--${name}-text`, contrast(value));
  localStorage.setItem(`aria-${name}`, value);
}

for (const name of ["theme", "accent"]) {
  const input = $(`#${name}`);
  input.value = localStorage.getItem(`aria-${name}`) ?? input.value;
  theme(name, input.value);
  input.addEventListener("input", e => theme(name, e.target.value));
}

const artFallback = "assets/album.svg";
const mmss = seconds => `${Math.floor((seconds || 0) / 60)}:${String(Math.floor((seconds || 0) % 60)).padStart(2, "0")}`;

function updateAuthLinks() {
  const base = getApiBase();
  const currentUrl = encodeURIComponent(window.location.href);
  document.querySelectorAll(".signin a").forEach(a => {
    const defaultPath = a.getAttribute("data-path") || a.getAttribute("href") || "";
    if (!a.getAttribute("data-path")) a.setAttribute("data-path", defaultPath);
    const path = a.getAttribute("data-path");
    a.href = `${base}${path}?return_to=${currentUrl}`;
  });
}
updateAuthLinks();

function render(state) {
  const current = state.queue[state.index];
  $("#title").textContent = current?.title ?? "Ready when you are";
  $("#artist").textContent = current?.artist ?? "Aria Radio";
  $("#art").src = current?.artwork ?? artFallback;
  $("#elapsed").textContent = mmss(state.position);
  $("#duration").textContent = mmss(current?.duration);
  $("#progress").value = current?.duration ? (state.position / current.duration) * 100 : 0;
  $("#loop small").textContent = state.loop.toUpperCase();
  $("#count").textContent = `${state.queue.length} track${state.queue.length === 1 ? "" : "s"}`;
  $("#connection").textContent = state.voiceChannelId ? "Connected to your voice channel." : "Aria is not currently connected to voice.";
  $(".primary").textContent = state.paused ? "▶" : "Ⅱ";
  $("#queue").innerHTML = state.queue.length
    ? state.queue.map(t => `<li><img src="${t.artwork ?? artFallback}" alt=""><span><strong>${escapeHtml(t.title)}</strong><small>${escapeHtml(t.artist)}</small></span></li>`).join("")
    : `<li class="empty">Nothing queued yet.<br>Search for something you love.</li>`;
}

const escapeHtml = value => String(value).replace(/[&<>'"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[c]));

async function refresh() {
  try {
    render(await api(`/api/state?guild=${guildId}`));
  } catch (e) {
    $("#connection").textContent = e.message;
  }
}
refresh();
setInterval(refresh, 10000);

document.querySelectorAll("[data-action]").forEach(button =>
  button.addEventListener("click", async () =>
    render(await api(`/api/control/${button.dataset.action}`, { method: "POST", body: JSON.stringify({ guildId }) }))
  )
);

$("#search-form").addEventListener("submit", async event => {
  event.preventDefault();
  const results = await api(`/api/search?q=${encodeURIComponent($("#search").value)}`);
  $("#results").innerHTML = results.map((t, i) => `<a class="result" href="${t.url}" target="_blank" rel="noreferrer" data-i="${i}"><img src="${t.artwork ?? artFallback}" alt=""><span><strong>${escapeHtml(t.title)}</strong><small>${escapeHtml(t.artist)}</small></span><b>＋</b></a>`).join("");
  document.querySelectorAll(".result").forEach(link =>
    link.addEventListener("click", async e => {
      if (e.button !== 0) return;
      e.preventDefault();
      render(await api("/api/queue", { method: "POST", body: JSON.stringify({ guildId, track: results[Number(link.dataset.i)] }) }));
    })
  );
});
