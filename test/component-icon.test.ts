import { describe, expect, it } from "vitest";
import { readComponent } from "../src/marketplace/component";
import { ICON_SECTION, MAX_ICON_BYTES } from "../src/marketplace/icon";
import { component, pngChunk, pngIcon } from "./component-fixtures";

/** Reads one icon section while retaining ordinary metadata, so invalid icons cannot reject the component. */
const readIcon = (icon: Uint8Array) => readComponent(component([[ICON_SECTION, icon], ["version", "1.0.0"]]));

describe("component icons", () => {
  it("extracts exactly one valid top-level PNG and permits inclusive byte and side limits", () => {
    for (const png of [pngIcon(), pngIcon(256, 256), pngIcon(1, 1, 0, MAX_ICON_BYTES)]) {
      expect(readIcon(png)).toMatchObject({ icon: png, iconError: null, version: "1.0.0" });
    }
  });

  it("returns null without a diagnostic for a missing section and ignores nested sections", () => {
    expect(readComponent(component([]))).toMatchObject({ icon: null, iconError: null });
    const nested = component([[ICON_SECTION, pngIcon()]]);
    // Section 4 is a nested component; this small fixture's length fits one LEB byte.
    expect(nested.length).toBeLessThan(128);
    expect(readComponent(new Uint8Array([...component([]), 4, nested.length, ...nested]))).toMatchObject({ icon: null, iconError: null });
  });

  it.each([false, true])("ignores all duplicate icon sections, even when the first is invalid (%s)", invalid => {
    const declarations = readComponent(component([[ICON_SECTION, invalid ? new Uint8Array() : pngIcon()],
      [ICON_SECTION, pngIcon()], [ICON_SECTION, pngIcon()]]));
    expect(declarations).toMatchObject({ icon: null, iconError: "Duplicate icon sections." });
  });

  it.each([
    ["oversized", () => pngIcon(1, 1, 0, MAX_ICON_BYTES + 1), /256 KiB/],
    ["bad signature", () => new Uint8Array(20), /not a PNG/],
    ["too wide", () => pngIcon(257, 1), /1 and 256/],
    ["too tall", () => pngIcon(1, 257), /1 and 256/],
    ["zero dimension", () => pngIcon(0, 1), /1 and 256/],
    ["truncated chunk body", () => pngIcon().slice(0, 45), /truncated/],
    ["truncated chunk header", () => pngIcon().slice(0, -1), /truncated/],
    ["missing IEND", () => pngIcon().slice(0, -12), /missing PNG IEND/],
    ["bad CRC", () => { const bytes = pngIcon(); bytes[29] = bytes[29]! ^ 1; return bytes; }, /CRC/],
    ["IHDR not first", () => new Uint8Array([...pngIcon().slice(0, 8), ...pngChunk("IDAT", new Uint8Array()), ...pngIcon().slice(8)]), /start with PNG IHDR/],
    ["duplicate IHDR", () => { const bytes = pngIcon(); return new Uint8Array([...bytes.slice(0, 33), ...bytes.slice(8)]); }, /invalid PNG IHDR/],
    ["unbounded chunk length", () => { const bytes = pngIcon(); bytes.fill(255, 33, 37); return bytes; }, /truncated/],
    ["missing IDAT", () => { const bytes = pngIcon(); return new Uint8Array([...bytes.slice(0, 33), ...bytes.slice(-12)]); }, /invalid PNG IEND/],
  ] as const)("ignores a %s icon and records the reason", (_, make, reason) => {
    expect(readIcon(make())).toMatchObject({ icon: null, iconError: expect.stringMatching(reason), version: "1.0.0" });
  });

  it("checks PNG structure without claiming to decode compressed pixels", () => {
    const png = new Uint8Array([...pngIcon().slice(0, 33), ...pngChunk("IDAT", new Uint8Array([1, 2, 3])), ...pngChunk("IEND", new Uint8Array())]);
    expect(readIcon(png)).toMatchObject({ icon: png, iconError: null });
  });
});
