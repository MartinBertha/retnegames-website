// Checks for object styles: the shared definitions, how a style is stored and
// drawn, and that the server's rules match (docs/hub-spec.md, section 6).

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ALPHAS,
  COLOR_KEYS,
  FONT_NAMES,
  LIST_NAMES,
  OBJECT_STYLES,
  alphaOf,
  defaultExtra,
  extraValue,
  extrasOf,
  isList,
  sanitizeStyle,
  setAlpha,
  setExtra,
  setTextValue,
  sizesOf,
  styleVars,
  textValue
} from "../public/hub/styles.js";
import { HttpError } from "../src/hub/http.js";
import { PALETTE, STYLE_RULES, validateItem } from "../src/hub/validate.js";

const ID = "a1b2c3d4-1111-4111-8111-11111111111f";
const note = (data = {}) => ({
  id: ID,
  type: "note",
  x: 0,
  y: 0,
  w: 240,
  h: 120,
  z: 1,
  color: null,
  data: { title: "", text: "Hi", size: "m", ...data }
});
const item = (type, data = {}) => ({ type, data, color: null });

function rejects(raw, pattern) {
  assert.throws(
    () => validateItem(raw),
    (error) => error instanceof HttpError && error.status === 400 && pattern.test(error.message)
  );
}

describe("style definitions", () => {
  it("offer 16 colours: the default and 15 keys, as the server accepts", () => {
    assert.equal(COLOR_KEYS.length, 15);
    assert.deepEqual([...PALETTE].sort(), [...COLOR_KEYS].sort());
    // The original palette keeps its keys.
    for (const key of ["grey", "red", "orange", "yellow", "green", "teal", "blue", "purple"]) {
      assert.ok(PALETTE.has(key), key);
    }
  });

  it("match the server's rules for every kind of object", () => {
    assert.deepEqual(Object.keys(OBJECT_STYLES).sort(), Object.keys(STYLE_RULES).sort());

    for (const [type, spec] of Object.entries(OBJECT_STYLES)) {
      const rules = STYLE_RULES[type];

      assert.equal(Boolean(spec.alpha), rules.alpha, `${type} opacity`);
      assert.deepEqual(spec.sets.map((set) => set.key).sort(), Object.keys(rules.sets).sort(), `${type} texts`);

      for (const set of spec.sets) {
        assert.deepEqual([...set.props].sort(), [...rules.sets[set.key].props].sort(), `${type}.${set.key}`);
        assert.deepEqual(sizesOf(set), rules.sets[set.key].sizes ?? ["s", "m", "l", "xl"], `${type}.${set.key} sizes`);
      }
    }
  });

  it("offer three system fonts and four opacities", () => {
    assert.deepEqual(Object.keys(FONT_NAMES), ["sans", "serif", "mono"]);
    assert.deepEqual(ALPHAS, [100, 75, 50, 25]);
  });
});

describe("setting a style", () => {
  it("stores only what differs from the default, and prunes what empties", () => {
    const n = item("note", { size: "m", title: "", text: "" });

    setTextValue(n, "body", "italic", true);
    setTextValue(n, "title", "bold", false);
    setTextValue(n, "body", "color", "red");
    assert.deepEqual(n.data.style, { body: { italic: true, color: "red" }, title: { bold: false } });

    setTextValue(n, "body", "italic", false);
    setTextValue(n, "body", "color", null);
    setTextValue(n, "title", "bold", true);
    assert.equal(n.data.style, undefined);
  });

  it("knows what is bold by default for each piece of text", () => {
    assert.equal(textValue(item("note", {}), "title", "bold"), true);
    assert.equal(textValue(item("note", {}), "body", "bold"), false);
    assert.equal(textValue(item("folder", {}), "label", "bold"), false);
    assert.equal(textValue(item("link", {}), "text", "bold"), true);
  });

  it("keeps opacity as 75, 50 or 25 and drops 100", () => {
    const n = item("note", { size: "m" });

    assert.equal(alphaOf(n), 100);
    setAlpha(n, 50);
    assert.deepEqual(n.data.style, { alpha: 50 });
    assert.equal(alphaOf(n), 50);
    setAlpha(n, 100);
    assert.equal(n.data.style, undefined);
  });

  it("keeps a note's body size where it always was (data.size), and the title's size apart", () => {
    const n = item("note", { size: "m" });

    setTextValue(n, "body", "size", "xl");
    assert.equal(n.data.size, "xl");
    assert.equal(textValue(n, "body", "size"), "xl");
    // The title was medium and stays so.
    assert.equal(textValue(n, "title", "size"), "m");
    assert.deepEqual(n.data.style, { title: { size: "m" } });

    setTextValue(n, "title", "size", "xl");
    assert.equal(n.data.style, undefined);
  });

  it("sizes a note made before titles had their own size by its whole size", () => {
    const small = item("note", { size: "s" });

    assert.equal(textValue(small, "title", "size"), "s");
    assert.equal(styleVars(small)["--title-size"], "17px");

    // Changing the body keeps the title as it looked.
    setTextValue(small, "body", "size", "l");
    assert.equal(textValue(small, "title", "size"), "s");
    assert.equal(small.data.size, "l");
  });
});

describe("drawing a style", () => {
  it("is nothing for an object that was never styled", () => {
    for (const type of Object.keys(OBJECT_STYLES)) {
      assert.deepEqual(styleVars(item(type, { size: "m" })), {}, type);
    }
  });

  it("turns each property into a custom property the stylesheet reads", () => {
    const n = item("note", { size: "m" });

    setTextValue(n, "title", "color", "blue");
    setTextValue(n, "title", "font", "serif");
    setTextValue(n, "title", "size", "xl");
    setTextValue(n, "body", "bold", true);
    setTextValue(n, "body", "italic", true);
    setTextValue(n, "body", "align", "center");
    setTextValue(n, "body", "valign", "bottom");
    setAlpha(n, 75);

    assert.deepEqual(styleVars(n), {
      "--alpha": "0.75",
      "--title-color": "var(--ink-blue)",
      "--title-font": "var(--font-serif)",
      "--title-size": "36px",
      "--body-weight": "700",
      "--body-style": "italic",
      "--body-align": "center",
      "--body-valign": "flex-end"
    });
  });

  it("makes big note text sit closer together, and turns a default-bold text plain", () => {
    const n = item("note", { size: "l" });
    setTextValue(n, "title", "bold", false);

    assert.equal(styleVars(n)["--body-size"], "22px");
    assert.equal(styleVars(n)["--body-leading"], "1.3");
    assert.equal(styleVars(n)["--title-weight"], "400");
  });

  it("styles the pieces of a checklist and a folder", () => {
    const list = item("checklist", {});
    setTextValue(list, "items", "size", "l");
    setTextValue(list, "title", "italic", true);
    assert.deepEqual(styleVars(list), { "--items-size": "18px", "--title-style": "italic" });

    const folder = item("folder", {});
    setTextValue(folder, "label", "size", "l");
    setTextValue(folder, "label", "bold", true);
    assert.deepEqual(styleVars(folder), { "--label-size": "19px", "--label-weight": "700" });
  });
});

describe("sanitizing a style", () => {
  it("keeps what is valid for the kind of object and drops the rest", () => {
    assert.deepEqual(
      sanitizeStyle("note", { alpha: 50, body: { size: "xl", font: "comic", bogus: 1, color: "red" }, nothing: {} }),
      { alpha: 50, body: { size: "xl", color: "red" } }
    );
    // A folder has no opacity, a smaller size range and no alignment.
    assert.deepEqual(sanitizeStyle("folder", { alpha: 50, label: { size: "xl", align: "center", bold: true } }), { label: { bold: true } });
    assert.equal(sanitizeStyle("note", "red"), undefined);
    assert.equal(sanitizeStyle("note", { alpha: 100 }), undefined);
    assert.equal(sanitizeStyle("unknown", { alpha: 50 }), undefined);
  });
});

describe("the server", () => {
  it("keeps a valid style and drops the defaults", () => {
    const saved = validateItem(note({ style: { alpha: 75, title: { bold: false, font: "mono" }, body: { valign: "middle" } } }));

    assert.deepEqual(saved.data.style, { alpha: 75, title: { bold: false, font: "mono" }, body: { valign: "middle" } });
    assert.equal(validateItem(note({ style: { alpha: 100 } })).data.style, undefined);
    assert.equal(validateItem(note({ style: {} })).data.style, undefined);
    assert.equal(validateItem(note()).data.style, undefined);
  });

  it("drops text sets and properties the object doesn't have", () => {
    const saved = validateItem(note({ style: { footer: { bold: true }, title: { valign: "top", bold: true } } }));

    assert.deepEqual(saved.data.style, { title: { bold: true } });
  });

  it("rejects values out of range", () => {
    rejects(note({ style: { alpha: 60 } }), /Invalid opacity/);
    rejects(note({ style: { body: { font: "comic" } } }), /Invalid style/);
    rejects(note({ style: { body: { size: "xxl" } } }), /Invalid style/);
    rejects(note({ style: { body: { color: "mauve" } } }), /Invalid style/);
    rejects(note({ style: { body: { bold: "yes" } } }), /Invalid style/);
    rejects(note({ style: { body: { align: "justify" } } }), /Invalid style/);
    rejects(note({ style: "red" }), /Invalid style/);
    rejects(note({ style: { body: [] } }), /Invalid style/);
  });

  it("limits a folder's label to three sizes and gives it no opacity", () => {
    const folder = (style) => ({
      ...note(),
      type: "folder",
      data: { name: "Art", childBoardId: "22222222-2222-4222-8222-222222222222", style }
    });

    assert.equal(validateItem(folder({ label: { size: "l" } })).data.style.label.size, "l");
    rejects(folder({ label: { size: "xl" } }), /Invalid style/);
    rejects(folder({ alpha: 50 }), /Invalid opacity/);
  });

  it("styles lines and images with an opacity", () => {
    const line = {
      ...note(),
      type: "connector",
      x: 0,
      y: 0,
      w: 120,
      h: 0,
      color: "indigo",
      data: { start: { x: 0, y: 0 }, end: { x: 120, y: 0 }, style: { alpha: 25 } }
    };

    assert.equal(validateItem(line).data.style.alpha, 25);
    assert.equal(validateItem(line).color, "indigo");
    assert.equal(validateItem({ ...note(), type: "image", data: { fileId: ID, style: { alpha: 50, caption: { size: "l", align: "center" } } } }).data.style.caption.align, "center");
  });
});

describe("extras: borders, corners, flips and strokes", () => {
  it("match the server's rules", () => {
    for (const [type, rules] of Object.entries(STYLE_RULES)) {
      const extras = extrasOf(type);

      assert.deepEqual(extras.map((extra) => extra.key).sort(), Object.keys(rules.extras ?? {}).sort(), `${type} extras`);

      for (const extra of extras) {
        const allowed = rules.extras[extra.key];

        if (extra.kind === "choice") {
          assert.deepEqual(Object.keys(extra.options), allowed, `${type}.${extra.key}`);
          assert.ok(Object.keys(extra.options).includes(defaultExtra(item(type, {}), extra.key)), `${type}.${extra.key} default`);
        } else {
          assert.equal(allowed, extra.kind === "color" ? "color" : "bool", `${type}.${extra.key}`);
        }
      }
    }
  });

  it("store only what differs from the default", () => {
    const image = item("image", {});

    assert.equal(extraValue(image, "border"), "none");
    setExtra(image, "border", "thick");
    setExtra(image, "flipX", true);
    assert.deepEqual(image.data.style, { border: "thick", flipX: true });

    setExtra(image, "border", "none");
    setExtra(image, "flipX", false);
    assert.equal(image.data.style, undefined);
  });

  it("give a section the border it has always had: dashed, or solid with a colour", () => {
    const plain = item("section", {});
    const coloured = { ...item("section", {}), color: "blue" };

    assert.equal(extraValue(plain, "border"), "dashed");
    assert.equal(extraValue(coloured, "border"), "solid");
    assert.deepEqual(styleVars(plain), {});
    assert.deepEqual(styleVars(coloured), {});

    setExtra(plain, "border", "solid");
    setExtra(coloured, "border", "none");
    assert.deepEqual(styleVars(plain), { "--border-style": "solid" });
    assert.deepEqual(styleVars(coloured), { "--border-color": "transparent" });
  });

  it("draw an image's border, corners and flips", () => {
    const image = item("image", {});

    setExtra(image, "border", "thin");
    assert.deepEqual(styleVars(image), { "--border-width": "2px", "--border-color": "var(--text)" });

    setExtra(image, "borderColor", "red");
    setExtra(image, "border", "thick");
    setExtra(image, "corners", "rounded");
    setExtra(image, "flipX", true);
    setExtra(image, "flipY", true);
    assert.deepEqual(styleVars(image), {
      "--border-width": "5px",
      "--border-color": "var(--ink-red)",
      "--corner": "16px",
      "--flip-x": "-1",
      "--flip-y": "-1"
    });
  });

  it("draw a line's thickness and dashes, and leave the default alone", () => {
    const line = item("connector", { start: { x: 0, y: 0 }, end: { x: 5, y: 5 } });

    assert.deepEqual(styleVars(line), {});
    setExtra(line, "thickness", "thick");
    setExtra(line, "dash", "dashed");
    assert.deepEqual(styleVars(line), { "--stroke": "3.5px", "--dash-on": "4", "--dash-off": "3" });

    setExtra(line, "thickness", "thin");
    setExtra(line, "dash", "dotted");
    assert.deepEqual(styleVars(line), { "--stroke": "1.5px", "--dash-on": "0.01", "--dash-off": "2.2", "--cap": "round" });

    // The arrowhead is drawn from data.style.arrow when the line is rendered.
    setExtra(line, "arrow", "both");
    assert.equal(line.data.style.arrow, "both");
    setExtra(line, "arrow", "end");
    assert.equal(line.data.style.arrow, undefined);
  });

  it("strike through ticked items, and hide a link's address", () => {
    const list = item("checklist", {});
    setTextValue(list, "items", "strike", true);
    assert.deepEqual(styleVars(list), { "--items-strike": "line-through" });
    setTextValue(list, "items", "strike", false);
    assert.equal(list.data.style, undefined);

    const link = item("link", {});
    assert.equal(textValue(link, "text", "address"), true);
    setTextValue(link, "text", "address", false);
    assert.deepEqual(styleVars(link), { "--text-address": "none" });
    setTextValue(link, "text", "address", true);
    assert.equal(link.data.style, undefined);
  });

  it("are sanitized like the rest of a style", () => {
    assert.deepEqual(
      sanitizeStyle("image", { border: "thick", borderColor: "mauve", corners: "rounded", flipX: "yes", flipY: true, arrow: "end" }),
      { border: "thick", corners: "rounded", flipY: true }
    );
    assert.deepEqual(sanitizeStyle("connector", { dash: "dotted", thickness: "huge", arrow: "both" }), { dash: "dotted", arrow: "both" });
    assert.deepEqual(sanitizeStyle("checklist", { items: { strike: true, address: true } }), { items: { strike: true } });
    assert.equal(sanitizeStyle("note", { border: "thick" }), undefined);
  });

  it("are kept by the server, which drops what an object doesn't have and rejects bad values", () => {
    const image = (style) => ({ ...note(), type: "image", data: { fileId: ID, style } });
    const saved = validateItem(image({ border: "thick", borderColor: "blue", corners: "rounded", flipX: true, dash: "dashed" }));

    assert.deepEqual(saved.data.style, { border: "thick", borderColor: "blue", corners: "rounded", flipX: true });
    rejects(image({ border: "huge" }), /Invalid style/);
    rejects(image({ borderColor: "mauve" }), /Invalid style/);
    rejects(image({ flipX: "yes" }), /Invalid style/);

    const line = (style) => ({
      ...note(),
      type: "connector",
      w: 120,
      h: 0,
      data: { start: { x: 0, y: 0 }, end: { x: 120, y: 0 }, style }
    });

    assert.deepEqual(validateItem(line({ thickness: "thick", dash: "dotted", arrow: "none" })).data.style, { thickness: "thick", dash: "dotted", arrow: "none" });
    rejects(line({ arrow: "middle" }), /Invalid style/);

    const section = (style) => ({ ...note(), type: "section", data: { title: "S", style } });
    assert.equal(validateItem(section({ border: "none" })).data.style.border, "none");
    rejects(section({ border: "double" }), /Invalid style/);

    const list = (style) => ({ ...note(), type: "checklist", data: { title: "", entries: [], style } });
    assert.equal(validateItem(list({ items: { strike: true } })).data.style.items.strike, true);
    rejects(list({ items: { strike: "yes" } }), /Invalid style/);
  });
});

describe("list formatting of a note's body", () => {
  it("is plain text by default, and stores only an actual list", () => {
    const n = item("note", { size: "m" });

    assert.deepEqual(Object.keys(LIST_NAMES), ["none", "bullet", "number", "alpha"]);
    assert.equal(textValue(n, "body", "list"), "none");
    assert.equal(isList(n, "body"), false);

    setTextValue(n, "body", "list", "number");
    assert.deepEqual(n.data.style, { body: { list: "number" } });
    assert.equal(isList(n, "body"), true);

    setTextValue(n, "body", "list", "none");
    assert.equal(n.data.style, undefined);
    assert.equal(isList(n, "body"), false);
  });

  it("is offered for a note's body and nowhere else", () => {
    for (const [type, spec] of Object.entries(OBJECT_STYLES)) {
      for (const set of spec.sets) {
        assert.equal(set.props.includes("list"), type === "note" && set.key === "body", `${type}.${set.key}`);
      }
    }
  });

  it("indents the lines and draws them left-aligned, keeping the alignment for later", () => {
    const n = item("note", { size: "m" });

    setTextValue(n, "body", "align", "center");
    assert.equal(styleVars(n)["--body-align"], "center");
    assert.equal(styleVars(n)["--body-indent"], undefined);

    setTextValue(n, "body", "list", "bullet");
    assert.equal(styleVars(n)["--body-align"], undefined);
    assert.equal(styleVars(n)["--body-indent"], "1.9em");
    assert.equal(n.data.style.body.align, "center");

    setTextValue(n, "body", "list", "none");
    assert.equal(styleVars(n)["--body-align"], "center");
    assert.equal(styleVars(n)["--body-indent"], undefined);
  });

  it("is sanitized for copied cards, and only for the body of a note", () => {
    assert.deepEqual(sanitizeStyle("note", { body: { list: "alpha", align: "right" } }), { body: { list: "alpha", align: "right" } });
    assert.equal(sanitizeStyle("note", { body: { list: "roman" } }), undefined);
    assert.equal(sanitizeStyle("note", { title: { list: "bullet" } }), undefined);
    assert.equal(sanitizeStyle("checklist", { items: { list: "bullet" } }), undefined);
  });

  it("is kept by the server for every kind of list, and nothing else", () => {
    for (const list of Object.keys(LIST_NAMES)) {
      assert.equal(validateItem(note({ style: { body: { list } } })).data.style.body.list, list);
    }

    rejects(note({ style: { body: { list: "roman" } } }), /Invalid style/);
    rejects(note({ style: { body: { list: true } } }), /Invalid style/);
    // A title (or a checklist) has no list; the property is dropped.
    assert.equal(validateItem(note({ style: { title: { list: "bullet" } } })).data.style, undefined);
  });
});
