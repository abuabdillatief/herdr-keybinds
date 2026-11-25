// Visual keybinding editor for Herdr GUI.
// Reads and writes ~/.config/herdr-app/keys.json atomically with live reload.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import {
  appHome,
  checking,
  closeOverlay,
  commands,
  notify,
  props,
  readTextFile,
  theme,
  window as appWindow,
  writeTextFile,
} from "herdr";

const GROUPS = [
  ["Spaces", /^space\./],
  ["Tabs", /^tab\./],
  ["Panes", /^pane\./],
  ["Agents", /^agent\./],
  ["Terminal", /^terminal\.|^send:|^terminal$/],
  ["Layout & App", /^layout\.|^app\.|^window\.|^mod\./],
  ["Custom", /./],
];

const MODIFIER_NAMES = new Set(["cmd", "ctrl", "alt", "shift", "super"]);
const BARE_MODIFIERS = new Set([
  "shift",
  "control",
  "ctrl",
  "alt",
  "option",
  "cmd",
  "command",
  "super",
  "meta",
  "platform",
  "function",
  "fn",
  "capslock",
]);

const RISKY_TERMINAL_KEYS = new Set([
  "ctrl-c",
  "ctrl-d",
  "ctrl-l",
  "ctrl-r",
  "ctrl-w",
  "ctrl-a",
  "ctrl-e",
  "ctrl-u",
  "ctrl-k",
  "ctrl-z",
  "ctrl-[",
]);

const ESCAPE_HATCH = "ctrl-alt-shift-escape";

const MAC_KEY_LABELS = {
  cmd: "⌘",
  ctrl: "⌃",
  alt: "⌥",
  shift: "⇧",
  enter: "↵",
  escape: "Esc",
  backspace: "⌫",
  delete: "⌦",
  tab: "⇥",
  left: "←",
  right: "→",
  up: "↑",
  down: "↓",
  space: "Space",
};

const GENERIC_KEY_LABELS = {
  cmd: "Cmd",
  ctrl: "Ctrl",
  alt: "Alt",
  shift: "Shift",
  super: "Super",
  enter: "Enter",
  escape: "Esc",
  backspace: "Bksp",
  delete: "Del",
  tab: "Tab",
  left: "←",
  right: "→",
  up: "↑",
  down: "↓",
  space: "Space",
};

function splitKeystroke(ks) {
  if (!ks) return [];
  const parts = [];
  let rest = ks;
  while (true) {
    const idx = rest.indexOf("-");
    if (idx <= 0) break;
    const head = rest.slice(0, idx);
    if (!MODIFIER_NAMES.has(head)) break;
    parts.push(head);
    rest = rest.slice(idx + 1);
  }
  if (rest.length > 0) parts.push(rest);
  return parts;
}

function formatKeyToken(token, isMac) {
  const map = isMac ? MAC_KEY_LABELS : GENERIC_KEY_LABELS;
  if (map[token]) return map[token];
  if (token.length === 1) return token.toUpperCase();
  if (/^f\d{1,2}$/i.test(token)) return token.toUpperCase();
  return token;
}

function actionKey(action) {
  if (typeof action === "string") return action;
  if (action && typeof action === "object" && typeof action.command === "string") {
    return action.command;
  }
  return "";
}

function formatAction(action) {
  if (typeof action === "string") {
    if (action === "terminal") return "Pass key to terminal";
    if (action.startsWith("send:")) return "Send " + JSON.stringify(action.slice(5));
    const idx = action.indexOf(":");
    if (idx > 0) {
      const name = action.slice(0, idx).replace(/[._]/g, " ");
      const arg = action.slice(idx + 1);
      return `${name} (${arg})`;
    }
    return action.replace(/[._]/g, " ");
  }
  if (action && typeof action === "object" && typeof action.command === "string") {
    const args = action.args && Object.keys(action.args).length > 0 ? " " + JSON.stringify(action.args) : "";
    return `${action.command}${args}`;
  }
  return String(action);
}

function cloneJson(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function replaceKeyInOrder(sectionObj, oldKey, newKey, value) {
  const next = {};
  let replaced = false;
  for (const [k, v] of Object.entries(sectionObj)) {
    if (k === newKey && k !== oldKey) continue;
    if (k === oldKey) {
      next[newKey] = value;
      replaced = true;
    } else {
      next[k] = v;
    }
  }
  if (!replaced) next[newKey] = value;
  return next;
}

function keycaps(t, ks, isMac, accent) {
  const tokens = splitKeystroke(ks);
  return h_flex()
    .gap(3)
    .items_center()
    .children(
      tokens.map((tok, i) =>
        div()
          .px(6)
          .py(2)
          .rounded(5)
          .border_1()
          .border_color(accent ? t.accent : t.input)
          .bg(accent ? t.selected : t.background)
          .text_size(11)
          .font_medium()
          .text_color(accent ? t.accent : t.foreground)
          .child(formatKeyToken(tok, isMac)),
      ),
    );
}

export default class Keybinds extends View {
  init(_props, cx) {
    this.keysPath = `${appHome()}/keys.json`;
    this.rawText = null;
    this.data = {};
    this.history = [];
    this.loading = true;
    this.error = null;
    this.status = null;

    this.filter = "";
    this.sectionFilter = "all";

    // Rebinding state: { section, oldKey, action } | null
    this.recording = null;
    // Pending confirmation: { kind: "conflict" | "risky", section, oldKey, newKey, action, existingAction? } | null
    this.pending = null;

    // Add-binding drawer state
    this.adding = false;
    this.addSection = "global";
    this.addAction = "";
    this.addKey = "";
    this.addRecording = false;
    this.addError = null;

    this.searchInput = InputState.new({ placeholder: "Filter shortcuts or commands…" });
    this.searchInput.on("change", (_e, cx) => {
      this.filter = this.searchInput.value();
      cx.notify();
    });

    this.actionInput = InputState.new({ placeholder: "Command (e.g. tab.new, pane.split:right, send:\\u001bb)" });
    this.actionInput.on("change", (_e, cx) => {
      this.addAction = this.actionInput.value();
      this.addError = null;
      cx.notify();
    });

    this.handle = cx.focus_handle();
    this.captureHandle = cx.focus_handle();

    if (checking()) {
      this.loading = false;
      this.data = {
        global: { "cmd-t": "tab.new", "cmd-d": "pane.split:right" },
        terminal: { "cmd-c": "terminal.copy" },
      };
      return;
    }

    this.searchInput.focus();
    cx.timer.after(150, () => {
      if (!this.recording && !this.adding) this.searchInput.focus();
    });

    this.loadKeys(cx);
  }

  close() {
    const id = props()?.overlay;
    if (id) closeOverlay(id);
  }

  loadKeys(cx) {
    cx.spawn(async (cx) => {
      try {
        const text = await readTextFile(this.keysPath);
        this.rawText = text;
        this.data = text ? JSON.parse(text) : { global: {}, terminal: {} };
        this.error = null;
      } catch (err) {
        this.error = `Could not read keys.json: ${err?.message ?? err}`;
      }
      this.loading = false;
      cx.notify();
    });
  }

  saveData(nextData, statusMsg, cx, pushHistory = true) {
    const prevSnapshot = pushHistory ? cloneJson(this.data) : null;
    const prevRaw = this.rawText;
    const serialized = JSON.stringify(nextData, null, 2) + "\n";

    cx.spawn(async (cx) => {
      try {
        await writeTextFile(this.keysPath, serialized, prevRaw);
        if (prevSnapshot) {
          this.history.push(prevSnapshot);
          if (this.history.length > 30) this.history.shift();
        }
        this.data = nextData;
        this.rawText = serialized;
        this.error = null;
        this.status = statusMsg;
      } catch (err) {
        // Re-sync in case keys.json changed externally
        try {
          const fresh = await readTextFile(this.keysPath);
          this.rawText = fresh;
          if (fresh) this.data = JSON.parse(fresh);
        } catch {}
        this.error = `Save failed (keys.json changed externally — reloaded): ${err?.message ?? err}`;
      }
      cx.notify();
    });
  }

  undo(cx) {
    if (this.history.length === 0) return;
    const prev = this.history.pop();
    this.recording = null;
    this.pending = null;
    this.saveData(prev, "Reverted last change", cx, false);
  }

  startRecording(section, oldKey, action, cx) {
    this.adding = false;
    this.addRecording = false;
    this.pending = null;
    this.status = null;
    this.recording = { section, oldKey, action };
    this.captureHandle.focus();
    cx.notify();
  }

  cancelRecording(cx) {
    this.recording = null;
    this.pending = null;
    this.addRecording = false;
    this.handle.focus();
    cx.notify();
  }

  applyRebind(section, oldKey, newKey, action, cx) {
    const next = cloneJson(this.data);
    if (!next[section] || typeof next[section] !== "object") next[section] = {};
    next[section] = replaceKeyInOrder(next[section], oldKey, newKey, action);
    this.recording = null;
    this.pending = null;
    this.saveData(next, `Bound ${newKey} → ${formatAction(action)}`, cx);
  }

  deleteBinding(section, key, action, cx) {
    const next = cloneJson(this.data);
    if (next[section] && Object.prototype.hasOwnProperty.call(next[section], key)) {
      delete next[section][key];
    }
    if (this.recording?.section === section && this.recording?.oldKey === key) {
      this.recording = null;
    }
    this.pending = null;
    this.saveData(next, `Removed ${key} (${formatAction(action)})`, cx);
  }

  handleCapturedKey(e, cx) {
    if (!e || e.is_held) return;
    const rawKey = (e.key ?? "").toLowerCase();
    if (!rawKey || BARE_MODIFIERS.has(rawKey)) return;

    cx.stop_propagation();

    if (e.keystroke === "escape") {
      this.cancelRecording(cx);
      return;
    }

    const ks = e.keystroke;
    if (!ks) return;

    if (ks === ESCAPE_HATCH) {
      this.error = `${ESCAPE_HATCH} is reserved as Herdr's built-in escape hatch.`;
      this.recording = null;
      this.addRecording = false;
      cx.notify();
      return;
    }

    // Add-binding capture
    if (this.addRecording) {
      this.addKey = ks;
      this.addRecording = false;
      this.addError = null;
      this.handle.focus();
      cx.notify();
      return;
    }

    // Rebinding capture
    if (!this.recording) return;
    const { section, oldKey, action } = this.recording;

    if (ks === oldKey) {
      this.recording = null;
      this.status = "Unchanged";
      this.handle.focus();
      cx.notify();
      return;
    }

    const secObj = this.data?.[section] ?? {};
    if (Object.prototype.hasOwnProperty.call(secObj, ks)) {
      this.pending = {
        kind: "conflict",
        section,
        oldKey,
        newKey: ks,
        action,
        existingAction: secObj[ks],
      };
      this.recording = null;
      cx.notify();
      return;
    }

    if ((section === "global" || section === "terminal") && RISKY_TERMINAL_KEYS.has(ks)) {
      this.pending = {
        kind: "risky",
        section,
        oldKey,
        newKey: ks,
        action,
      };
      this.recording = null;
      cx.notify();
      return;
    }

    this.applyRebind(section, oldKey, ks, action, cx);
  }

  submitAdd(cx) {
    const action = this.addAction.trim();
    const key = this.addKey.trim();
    const section = this.addSection;

    if (!action) {
      this.addError = "Enter a command or action first.";
      cx.notify();
      return;
    }
    if (!key) {
      this.addError = "Click the shortcut box and press a key chord.";
      cx.notify();
      return;
    }
    if (key === ESCAPE_HATCH) {
      this.addError = `${ESCAPE_HATCH} is reserved as Herdr's escape hatch.`;
      cx.notify();
      return;
    }

    const next = cloneJson(this.data);
    if (!next[section] || typeof next[section] !== "object") next[section] = {};
    const existed = Object.prototype.hasOwnProperty.call(next[section], key);
    next[section][key] = action;

    this.adding = false;
    this.addAction = "";
    this.addKey = "";
    this.addRecording = false;
    this.addError = null;
    this.actionInput.set_value("");

    this.saveData(
      next,
      existed ? `Replaced ${key} in ${section} → ${action}` : `Added ${key} in ${section} → ${action}`,
      cx,
    );
  }

  sections() {
    const found = Object.keys(this.data ?? {}).filter(
      (k) => this.data[k] && typeof this.data[k] === "object" && !Array.isArray(this.data[k]),
    );
    const ordered = [];
    for (const std of ["global", "terminal"]) {
      if (found.includes(std)) ordered.push(std);
    }
    for (const k of found) {
      if (!ordered.includes(k)) ordered.push(k);
    }
    return ordered.length > 0 ? ordered : ["global", "terminal"];
  }

  entries() {
    const out = [];
    for (const section of this.sections()) {
      const map = this.data?.[section];
      if (!map || typeof map !== "object") continue;
      for (const [key, action] of Object.entries(map)) {
        out.push({ section, key, action });
      }
    }
    return out;
  }

  render(cx) {
    const t = theme();
    const isMac = appWindow()?.platform === "macos";
    const allCmds = commands() ?? [];
    const cmdHelp = Object.fromEntries(allCmds.map((c) => [c.name, c.about ?? ""]));
    const sections = this.sections();
    const allEntries = this.entries();

    const f = this.filter.trim().toLowerCase();
    const filtered = allEntries.filter((e) => {
      if (this.sectionFilter !== "all" && e.section !== this.sectionFilter) return false;
      if (!f) return true;
      const baseCmd = actionKey(e.action).split(":")[0];
      const about = cmdHelp[baseCmd] ?? "";
      return (
        e.key.toLowerCase().includes(f) ||
        formatAction(e.action).toLowerCase().includes(f) ||
        actionKey(e.action).toLowerCase().includes(f) ||
        e.section.toLowerCase().includes(f) ||
        about.toLowerCase().includes(f)
      );
    });

    const seen = new Set();
    const groups = GROUPS.map(([name, re]) => {
      const rows = filtered.filter((e) => {
        if (seen.has(e)) return false;
        if (!re.test(actionKey(e.action))) return false;
        seen.add(e);
        return true;
      });
      return [name, rows];
    }).filter(([, rows]) => rows.length > 0);

    // Command suggestions while adding
    const addQ = this.addAction.trim().toLowerCase();
    const suggestions = this.adding
      ? allCmds
          .filter((c) => !addQ || c.name.toLowerCase().includes(addQ) || (c.about ?? "").toLowerCase().includes(addQ))
          .slice(0, 6)
      : [];

    const pillBtn = (id, label, active, onClick) =>
      h_flex()
        .id(id)
        .h(26)
        .px(10)
        .items_center()
        .rounded(6)
        .border_1()
        .border_color(active ? t.accent : t.border)
        .bg(active ? t.selected : t.raised)
        .text_size(11.5)
        .font_medium()
        .text_color(active ? t.accent : t.muted)
        .cursor_pointer()
        .hover((s) => s.bg(active ? t.selected : t.hover).text_color(t.foreground))
        .on_click(onClick)
        .child(label);

    return v_flex()
      .id("keybinds-root")
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (this.recording || this.addRecording) {
          this.handleCapturedKey(e, cx);
          return;
        }
        if (e.key === "escape") {
          if (this.pending) {
            this.pending = null;
            cx.stop_propagation();
            cx.notify();
            return;
          }
          if (this.adding) {
            this.adding = false;
            this.addError = null;
            cx.stop_propagation();
            cx.notify();
            return;
          }
          this.close();
          cx.stop_propagation();
        }
      })
      .size_full()
      .min_h(0)
      .p(18)
      .gap(12)
      .bg(t.popover)
      .text_size(12.5)
      // Header
      .child(
        h_flex()
          .h(28)
          .flex_none()
          .items_center()
          .justify_between()
          .child(
            h_flex()
              .gap(8)
              .items_center()
              .child(div().text_size(15).font_semibold().text_color(t.foreground).child("Keybinds"))
              .child(
                div()
                  .px(7)
                  .py(2)
                  .rounded(5)
                  .bg(t.raised)
                  .text_size(11)
                  .text_color(t.dim)
                  .child(`${allEntries.length} bindings`),
              ),
          )
          .child(
            h_flex()
              .gap(6)
              .items_center()
              .when(this.history.length > 0, (el) =>
                el.child(
                  h_flex()
                    .id("kb-undo")
                    .h(26)
                    .px(9)
                    .items_center()
                    .rounded(6)
                    .border_1()
                    .border_color(t.input)
                    .bg(t.raised)
                    .text_size(11.5)
                    .text_color(t.foreground)
                    .cursor_pointer()
                    .hover((s) => s.bg(t.hover))
                    .on_click((_e, cx) => this.undo(cx))
                    .child("Undo"),
                ),
              )
              .child(
                h_flex()
                  .id("kb-add-toggle")
                  .h(26)
                  .px(10)
                  .items_center()
                  .rounded(6)
                  .bg(this.adding ? t.raised : t.solid)
                  .border_1()
                  .border_color(this.adding ? t.input : t.solid)
                  .text_size(11.5)
                  .font_medium()
                  .text_color(this.adding ? t.foreground : t.solid_foreground)
                  .cursor_pointer()
                  .hover((s) => s.opacity(0.88))
                  .on_click((_e, cx) => {
                    this.adding = !this.adding;
                    this.recording = null;
                    this.pending = null;
                    this.addRecording = false;
                    this.addError = null;
                    if (this.adding) {
                      this.addSection = this.sectionFilter === "all" ? "global" : this.sectionFilter;
                      this.actionInput.focus();
                    }
                    cx.notify();
                  })
                  .child(this.adding ? "Close" : "+ Add"),
              )
              .child(
                div()
                  .id("kb-esc")
                  .px(6)
                  .py(2)
                  .rounded(5)
                  .text_size(11)
                  .text_color(t.dim)
                  .cursor_pointer()
                  .hover((s) => s.bg(t.hover).text_color(t.foreground))
                  .on_click(() => this.close())
                  .child("Esc"),
              ),
          ),
      )
      // Hidden capture focus target so key recording doesn't type into search input
      .child(
        div()
          .id("kb-capture-sink")
          .track_focus(this.captureHandle)
          .on_key_down((e, cx) => this.handleCapturedKey(e, cx))
          .h(0)
          .w(0),
      )
      // Recording banner
      .when(this.recording !== null, (el) =>
        el.child(
          h_flex()
            .flex_none()
            .px(12)
            .py(9)
            .rounded(8)
            .border_1()
            .border_color(t.accent)
            .bg(t.selected)
            .items_center()
            .justify_between()
            .gap(10)
            .child(
              h_flex()
                .gap(8)
                .items_center()
                .child(div().size(8).rounded(4).bg(t.accent).loop("opacity", { from: 0.35, to: 1, period: 900 }))
                .child(
                  div()
                    .text_color(t.foreground)
                    .font_medium()
                    .child(`Press new shortcut for "${formatAction(this.recording.action)}" (${this.recording.section})…`),
                ),
            )
            .child(
              h_flex()
                .id("kb-rec-cancel")
                .px(8)
                .py(3)
                .rounded(5)
                .bg(t.raised)
                .border_1()
                .border_color(t.input)
                .text_size(11)
                .text_color(t.muted)
                .cursor_pointer()
                .hover((s) => s.bg(t.hover).text_color(t.foreground))
                .on_click((_e, cx) => this.cancelRecording(cx))
                .child("Esc to cancel"),
            ),
        ),
      )
      // Conflict or risky-key confirmation banner
      .when(this.pending !== null, (el) => {
        const p = this.pending;
        const msg =
          p.kind === "conflict"
            ? `"${p.newKey}" is already bound to "${formatAction(p.existingAction)}" in ${p.section}. Replace it?`
            : `Terminal programs rely on "${p.newKey}". Bind it to "${formatAction(p.action)}" anyway?`;
        return el.child(
          h_flex()
            .flex_none()
            .px(12)
            .py(9)
            .rounded(8)
            .border_1()
            .border_color(t.blocked)
            .bg(t.raised)
            .items_center()
            .justify_between()
            .gap(10)
            .child(div().flex_1().text_color(t.foreground).child(msg))
            .child(
              h_flex()
                .gap(6)
                .items_center()
                .child(
                  h_flex()
                    .id("kb-pending-cancel")
                    .h(26)
                    .px(10)
                    .items_center()
                    .rounded(6)
                    .border_1()
                    .border_color(t.input)
                    .bg(t.background)
                    .text_size(11.5)
                    .text_color(t.muted)
                    .cursor_pointer()
                    .hover((s) => s.bg(t.hover).text_color(t.foreground))
                    .on_click((_e, cx) => {
                      this.pending = null;
                      cx.notify();
                    })
                    .child("Cancel"),
                )
                .child(
                  h_flex()
                    .id("kb-pending-confirm")
                    .h(26)
                    .px(10)
                    .items_center()
                    .rounded(6)
                    .bg(t.blocked)
                    .text_size(11.5)
                    .font_medium()
                    .text_color("#111111")
                    .cursor_pointer()
                    .hover((s) => s.opacity(0.88))
                    .on_click((_e, cx) => this.applyRebind(p.section, p.oldKey, p.newKey, p.action, cx))
                    .child(p.kind === "conflict" ? "Replace" : "Bind anyway"),
                ),
            ),
        );
      })
      // Add new binding composer
      .when(this.adding, (el) =>
        el.child(
          v_flex()
            .flex_none()
            .p(12)
            .gap(8)
            .rounded(9)
            .border_1()
            .border_color(t.input)
            .bg(t.surface)
            .child(
              h_flex()
                .items_center()
                .justify_between()
                .child(div().text_size(12).font_semibold().text_color(t.foreground).child("Add shortcut"))
                .child(
                  h_flex()
                    .gap(4)
                    .children(
                      sections.map((sec) =>
                        pillBtn(`kb-add-sec-${sec}`, sec, this.addSection === sec, (_e, cx) => {
                          this.addSection = sec;
                          cx.notify();
                        }),
                      ),
                    ),
                ),
            )
            .child(
              h_flex()
                .gap(8)
                .items_center()
                .child(
                  Input.new(this.actionInput)
                    .flex_1()
                    .h(34)
                    .px(10)
                    .rounded(7)
                    .border_1()
                    .border_color(t.input)
                    .bg(t.background)
                    .text_size(12)
                    .text_color(t.foreground),
                )
                .child(
                  h_flex()
                    .id("kb-add-capture")
                    .h(34)
                    .min_w(150)
                    .px(10)
                    .items_center()
                    .justify_center()
                    .rounded(7)
                    .border_1()
                    .border_color(this.addRecording ? t.accent : t.input)
                    .bg(this.addRecording ? t.selected : t.background)
                    .cursor_pointer()
                    .hover((s) => s.border_color(t.accent))
                    .on_click((_e, cx) => {
                      this.addRecording = true;
                      this.addError = null;
                      this.captureHandle.focus();
                      cx.notify();
                    })
                    .child(
                      this.addRecording
                        ? div().text_size(11.5).text_color(t.accent).child("Press keys…")
                        : this.addKey
                          ? keycaps(t, this.addKey, isMac, true)
                          : div().text_size(11.5).text_color(t.dim).child("Click to record key"),
                    ),
                )
                .child(
                  h_flex()
                    .id("kb-add-save")
                    .h(34)
                    .px(14)
                    .items_center()
                    .rounded(7)
                    .bg(t.solid)
                    .text_size(12)
                    .font_medium()
                    .text_color(t.solid_foreground)
                    .cursor_pointer()
                    .hover((s) => s.opacity(0.88))
                    .on_click((_e, cx) => this.submitAdd(cx))
                    .child("Add"),
                ),
            )
            .when(suggestions.length > 0, (box) =>
              box.child(
                h_flex()
                  .gap(5)
                  .flex_wrap()
                  .children(
                    suggestions.map((c) =>
                      div()
                        .id(`kb-sug-${c.name}`)
                        .px(7)
                        .py(3)
                        .rounded(5)
                        .border_1()
                        .border_color(t.border)
                        .bg(t.background)
                        .text_size(11)
                        .text_color(t.muted)
                        .cursor_pointer()
                        .hover((s) => s.bg(t.hover).text_color(t.foreground))
                        .on_click((_e, cx) => {
                          this.addAction = c.name;
                          this.actionInput.set_value(c.name);
                          this.addError = null;
                          cx.notify();
                        })
                        .child(c.name),
                    ),
                  ),
              ),
            )
            .when(Boolean(this.addError), (box) =>
              box.child(div().text_size(11.5).text_color(t.blocked).child(this.addError)),
            ),
        ),
      )
      // Search + Section filter pills
      .child(
        v_flex()
          .flex_none()
          .gap(8)
          .child(
            Input.new(this.searchInput)
              .h(36)
              .flex_none()
              .px(10)
              .rounded(9)
              .border_1()
              .border_color(t.accent)
              .bg(t.background)
              .text_size(12.8)
              .text_color(t.foreground),
          )
          .child(
            h_flex()
              .gap(6)
              .items_center()
              .justify_between()
              .child(
                h_flex()
                  .gap(5)
                  .items_center()
                  .child(
                    pillBtn("kb-sec-all", `All (${allEntries.length})`, this.sectionFilter === "all", (_e, cx) => {
                      this.sectionFilter = "all";
                      cx.notify();
                    }),
                  )
                  .children(
                    sections.map((sec) => {
                      const count = Object.keys(this.data?.[sec] ?? {}).length;
                      return pillBtn(`kb-sec-${sec}`, `${sec} (${count})`, this.sectionFilter === sec, (_e, cx) => {
                        this.sectionFilter = sec;
                        cx.notify();
                      });
                    }),
                  ),
              )
              .child(
                div()
                  .text_size(11)
                  .text_color(this.error ? t.blocked : this.status ? t.done : t.dim)
                  .truncate()
                  .child(this.error ?? this.status ?? "Click any shortcut to rebind · saves live to keys.json"),
              ),
          ),
      )
      // Bindings list
      .child(
        v_flex()
          .flex_1()
          .min_h(0)
          .overflow_y_scrollbar()
          .py(2)
          .gap(12)
          .when(this.loading, (el) =>
            el.child(div().p(12).text_color(t.dim).child("Loading keys.json…")),
          )
          .when(!this.loading && groups.length === 0, (el) =>
            el.child(div().p(12).text_color(t.dim).child("No shortcuts match your filter.")),
          )
          .when(!this.loading && groups.length > 0, (el) =>
            el.children(
              groups.map(([groupName, rows]) =>
                v_flex()
                  .gap(3)
                  .child(
                    div()
                      .px(6)
                      .text_size(11)
                      .font_semibold()
                      .text_color(t.dim)
                      .child(groupName.toUpperCase()),
                  )
                  .children(
                    rows.map((item) => {
                      const isRec =
                        this.recording?.section === item.section && this.recording?.oldKey === item.key;
                      const baseCmd = actionKey(item.action).split(":")[0];
                      const about = cmdHelp[baseCmd] ?? "";
                      const rowId = `kb-row-${item.section}-${item.key}`;
                      return h_flex()
                        .id(rowId)
                        .h(42)
                        .px(8)
                        .rounded(7)
                        .gap(10)
                        .items_center()
                        .bg(isRec ? t.selected : "#00000000")
                        .border_1()
                        .border_color(isRec ? t.accent : "#00000000")
                        .hover((s) => s.bg(isRec ? t.selected : t.hover))
                        // Action label + raw command
                        .child(
                          v_flex()
                            .flex_1()
                            .min_w(0)
                            .gap(2)
                            .child(
                              h_flex()
                                .gap(6)
                                .items_center()
                                .child(
                                  div()
                                    .text_size(12.5)
                                    .font_medium()
                                    .text_color(t.foreground)
                                    .truncate()
                                    .child(formatAction(item.action)),
                                )
                                .when(item.section !== "global", (b) =>
                                  b.child(
                                    div()
                                      .px(5)
                                      .py(1)
                                      .rounded(4)
                                      .bg(t.raised)
                                      .text_size(10)
                                      .text_color(t.dim)
                                      .child(item.section),
                                  ),
                                ),
                            )
                            .when(Boolean(about), (b) =>
                              b.child(div().text_size(10.5).text_color(t.dim).truncate().child(about)),
                            ),
                        )
                        // Clickable keycaps to rebind
                        .child(
                          h_flex()
                            .id(`kb-rebind-${item.section}-${item.key}`)
                            .px(6)
                            .py(3)
                            .rounded(6)
                            .items_center()
                            .cursor_pointer()
                            .hover((s) => s.bg(t.raised))
                            .on_click((_e, cx) => this.startRecording(item.section, item.key, item.action, cx))
                            .child(
                              isRec
                                ? div().px(6).text_size(11.5).font_medium().text_color(t.accent).child("Press keys…")
                                : keycaps(t, item.key, isMac, false),
                            ),
                        )
                        // Remove button
                        .child(
                          h_flex()
                            .id(`kb-del-${item.section}-${item.key}`)
                            .size(24)
                            .items_center()
                            .justify_center()
                            .rounded(5)
                            .text_size(13)
                            .text_color(t.dim)
                            .cursor_pointer()
                            .hover((s) => s.bg(t.raised).text_color(t.blocked))
                            .on_click((_e, cx) => this.deleteBinding(item.section, item.key, item.action, cx))
                            .child("×"),
                        );
                    }),
                  ),
              ),
            ),
          ),
      );
  }
}
