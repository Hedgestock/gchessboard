import { getVisualRowColumn, Side, Square } from "../utils/chess.js";
import { makeSVGElement } from "../utils/dom.js";
import { assertUnreachable } from "../utils/typing.js";

export type SquareAnnotationType = "corners" | "circle";

/**
 * A single square-level annotation: a corner-bracket highlight or a ring
 * outline.
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
   * `annotation-<type>-foo`, e.g. `annotation-circle-foo`. Defaults to `"red"`.
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

  private static _SQUARE_SIZE = 10;

  /**
   * Target gap between an annotation's *painted* (stroke-inclusive) outer
   * edge and the square's true edge, in this local per-square coordinate
   * space — shared by both `corners` and `circle` so they read as the same
   * inset as each other. Chosen to land on about 2 real screen pixels at
   * this app's typical board size (`#board { width: min(90vw, 32rem) }` →
   * 512px ÷ 8 squares = 64px/square, and this coordinate space is 10
   * units/square, so 1 unit ≈ 6.4px: `2 / 6.4 = 0.3125`). Purely
   * proportional, same as everything else in this layer (and gchessboard's
   * own `--move-target-marker-radius` etc.) — it'll read as more or less
   * than a literal 2px at other board sizes, not a fixed screen distance.
   */
  private static _OUTER_INSET = 2 / 6.4;

  private static _CORNER_STROKE_WIDTH = 0.85;
  private static _CIRCLE_STROKE_WIDTH = 0.85;

  /**
   * How far the corner brackets' straight arms reach, and the radius of
   * the quadratic curve rounding the true corner point — fixed proportions
   * of the bracket's own shape, independent of `_OUTER_INSET` (which only
   * moves the whole bracket closer to/further from the edge).
   */
  private static _CORNER_CURVE_RADIUS = 1;
  private static _CORNER_ARM_LENGTH = 2.2;

  /**
   * A stroked path's paint bleeds outward from its centerline by half the
   * stroke width, so the path itself has to sit that much *further* in
   * than `_OUTER_INSET` for its painted edge to land exactly there.
   */
  private static _CORNER_PATH_INSET =
    SquareAnnotations._OUTER_INSET + SquareAnnotations._CORNER_STROKE_WIDTH / 2;

  /**
   * Same reasoning as the corners' path inset, but for a circle the stroke
   * bleeds outward from the radius rather than a path centerline, so the
   * radius has to be *smaller* than `_SQUARE_SIZE / 2 - _OUTER_INSET` by
   * half the stroke width for its outer edge to land on `_OUTER_INSET`.
   */
  private static _CIRCLE_RADIUS =
    SquareAnnotations._SQUARE_SIZE / 2 -
    SquareAnnotations._OUTER_INSET -
    SquareAnnotations._CIRCLE_STROKE_WIDTH / 2;

  /**
   * One L-shaped bracket per corner, in this local 0-10 (one square)
   * coordinate space — translated into place per-square via a
   * `<g transform="translate(...)">` wrapper in `_makeAnnotation`. Computed
   * (rather than hardcoded) so `_OUTER_INSET` alone controls how far every
   * corner sits from the edge, without hand-recomputing four path strings
   * whenever that changes.
   */
  private static _cornerPath(corner: "tl" | "tr" | "bl" | "br"): string {
    const inset = SquareAnnotations._CORNER_PATH_INSET;
    const curve = SquareAnnotations._CORNER_CURVE_RADIUS;
    const arm = SquareAnnotations._CORNER_ARM_LENGTH;
    const xDir = corner === "tl" || corner === "bl" ? 1 : -1;
    const yDir = corner === "tl" || corner === "tr" ? 1 : -1;
    const cornerX = xDir === 1 ? inset : SquareAnnotations._SQUARE_SIZE - inset;
    const cornerY = yDir === 1 ? inset : SquareAnnotations._SQUARE_SIZE - inset;
    const curveEndX = cornerX + xDir * curve;
    const curveEndY = cornerY + yDir * curve;
    const armX = cornerX + xDir * (curve + arm);
    const armY = cornerY + yDir * (curve + arm);
    return `M ${cornerX} ${armY} L ${cornerX} ${curveEndY} Q ${cornerX} ${cornerY} ${curveEndX} ${cornerY} L ${armX} ${cornerY}`;
  }

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
      case "circle":
        return makeSVGElement("circle", {
          attributes: {
            cx: `${x + SquareAnnotations._SQUARE_SIZE / 2}`,
            cy: `${y + SquareAnnotations._SQUARE_SIZE / 2}`,
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
        (["tl", "tr", "bl", "br"] as const).forEach((corner) => {
          const d = SquareAnnotations._cornerPath(corner);
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
