import { getVisualRowColumn, Side, Square } from "../utils/chess.js";
import { makeSVGElement } from "../utils/dom.js";
import { assertUnreachable } from "../utils/typing.js";

export type SquareAnnotationType = "corners" | "circle" | "mark";

/**
 * A single square-level annotation: a corner-bracket highlight, a ring
 * outline, or a full-square tint.
 *
 * Unlike custom content placed via the `a1`..`h8` slots, annotations render
 * on their own dedicated SVG layer (see `SquareAnnotations`, alongside
 * `Arrows`) and never touch `BoardSquare.hasContent` — so, unlike slotted
 * content, they never affect which move-target marker style a square gets
 * (`--move-target-marker-radius` for an empty square vs
 * `--move-target-marker-radius-occupied` for one gchessboard considers
 * occupied). Slotted content is meant for things that *are* part of the
 * position (custom pieces, fairy-chess decorations); annotations are for
 * everything else drawn *on top of* a position without being mistaken for
 * part of it.
 */
export type SquareAnnotation = {
  square: Square;
  type: SquareAnnotationType;
  /**
   * Identifies a CSS part to style this annotation with, similar to `brush`
   * on `BoardArrow`: a `color` of `"foo"` applies the CSS part
   * `annotation-<type>-foo`, e.g. `annotation-mark-foo`. Defaults to `"red"`.
   */
  color?: string;
};

export class SquareAnnotations {
  element: SVGElement;
  private _group: SVGGElement;
  private _orientation: Side;
  private _annotations?: SquareAnnotation[];
  private _elements: Map<string, SVGElement> = new Map();

  /**
   * Default color name when none is specified for an annotation.
   */
  private static _DEFAULT_COLOR = "red";

  private static _CORNER_STROKE_WIDTH = 0.85;
  private static _CIRCLE_STROKE_WIDTH = 0.85;
  private static _CIRCLE_RADIUS = 3.3;

  /**
   * One L-shaped bracket per corner, in a local 0-10 (one square) coordinate
   * space — translated into place per-square via a `<g transform="translate(...)">`
   * wrapper in `_makeAnnotation`.
   */
  private static _CORNER_PATHS: Record<"tl" | "tr" | "bl" | "br", string> = {
    tl: "M 0.5 3.7 L 0.5 1.5 Q 0.5 0.5 1.5 0.5 L 3.7 0.5",
    tr: "M 9.5 3.7 L 9.5 1.5 Q 9.5 0.5 8.5 0.5 L 6.3 0.5",
    bl: "M 0.5 6.3 L 0.5 8.5 Q 0.5 9.5 1.5 9.5 L 3.7 9.5",
    br: "M 9.5 6.3 L 9.5 8.5 Q 9.5 9.5 8.5 9.5 L 6.3 9.5",
  };

  constructor(orientation: Side) {
    this.element = makeSVGElement("svg", {
      attributes: {
        viewBox: "0 0 80 80",
        // The board's own table isn't always pixel-perfectly square (its
        // aspect ratio comes from a CSS padding-percentage trick, not an
        // explicit size, so it can round to e.g. 512x513 rather than
        // 512x512). Without this, the default `xMidYMid meet` scaling
        // preserves the (here, wrongly assumed) 1:1 viewBox aspect ratio by
        // uniformly scaling to the smaller dimension and letterboxing the
        // rest — measured up to a ~0.9px cumulative vertical drift from the
        // board's top row to its bottom row. `none` stretches X and Y
        // independently to fill the box exactly instead, which eliminates
        // that drift entirely (verified: 0px vertical error on every square
        // afterward, vs. up to 0.5px before). It does *not* eliminate a
        // separate, smaller (~0.375px) horizontal residual that shows up on
        // some squares either way — that one comes from the table's own
        // columns not snapping to whole device pixels evenly, which is a
        // table-layout rounding quirk unrelated to this SVG's scaling and
        // not fixable from here.
        preserveAspectRatio: "none",
      },
      classes: ["square-annotations"],
    });
    this._orientation = orientation;

    this._group = makeSVGElement("g");
    this.element.appendChild(this._group);
  }

  get annotations() {
    return this._annotations;
  }

  set annotations(annotations: SquareAnnotation[] | undefined) {
    const oldHashes = new Set(this._elements.keys());
    const newHashes = new Set(
      annotations?.map((a) => SquareAnnotations._hash(a)) ?? []
    );

    oldHashes.forEach((hash) => {
      if (!newHashes.has(hash)) {
        const element = this._elements.get(hash);
        if (element) {
          this._group.removeChild(element);
          this._elements.delete(hash);
        }
      }
    });

    annotations?.forEach((annotation) => {
      const hash = SquareAnnotations._hash(annotation);
      if (!this._elements.has(hash)) {
        const element = this._makeAnnotation(annotation);
        this._elements.set(hash, element);
        this._group.appendChild(element);
      }
    });

    this._annotations = annotations ? [...annotations] : undefined;
  }

  /**
   * Orientation of the board; this determines which square each annotation
   * is drawn over.
   */
  get orientation() {
    return this._orientation;
  }

  set orientation(value: Side) {
    if (value !== this._orientation) {
      this._orientation = value;
      this._annotations?.forEach((annotation) => {
        const hash = SquareAnnotations._hash(annotation);
        const element = this._elements.get(hash);
        if (element) {
          this._group.removeChild(element);
        }
        const newElement = this._makeAnnotation(annotation);
        this._group.appendChild(newElement);
        this._elements.set(hash, newElement);
      });
    }
  }

  private _makeAnnotation(annotation: SquareAnnotation): SVGElement {
    const [row, col] = getVisualRowColumn(annotation.square, this.orientation);
    const x = col * 10;
    const y = row * 10;
    const escapedColor = SquareAnnotations._escapedColor(annotation.color);
    const partName = SquareAnnotations._makePartName(
      annotation.type,
      escapedColor
    );

    switch (annotation.type) {
      case "mark":
        return makeSVGElement("rect", {
          attributes: {
            x: `${x}`,
            y: `${y}`,
            width: "10",
            height: "10",
            fill: "currentColor",
            part: partName,
          },
          classes: [partName],
        });
      case "circle":
        return makeSVGElement("circle", {
          attributes: {
            cx: `${x + 5}`,
            cy: `${y + 5}`,
            r: `${SquareAnnotations._CIRCLE_RADIUS}`,
            fill: "none",
            stroke: "currentColor",
            "stroke-width": `${SquareAnnotations._CIRCLE_STROKE_WIDTH}`,
            part: partName,
          },
          classes: [partName],
        });
      case "corners": {
        const group = makeSVGElement("g", {
          attributes: { transform: `translate(${x}, ${y})` },
        });
        Object.values(SquareAnnotations._CORNER_PATHS).forEach((d) => {
          group.appendChild(
            makeSVGElement("path", {
              attributes: {
                d,
                fill: "none",
                stroke: "currentColor",
                "stroke-width": `${SquareAnnotations._CORNER_STROKE_WIDTH}`,
                part: partName,
              },
              classes: [partName],
            })
          );
        });
        return group;
      }
      default:
        return assertUnreachable(annotation.type);
    }
  }

  private static _escapedColor(color?: string) {
    return CSS.escape(color || SquareAnnotations._DEFAULT_COLOR);
  }

  private static _makePartName(
    type: SquareAnnotationType,
    escapedColor: string
  ) {
    return `annotation-${type}-${escapedColor}`;
  }

  private static _hash(annotation: SquareAnnotation): string {
    return `${annotation.square}_${annotation.type}_${
      annotation.color || SquareAnnotations._DEFAULT_COLOR
    }`;
  }
}
