/**
 * One JS number as a GLSL float literal — what every shader patch in `render/` splices its
 * constants through. The patches themselves are docs/render-occlusion.md, docs/render-lighting.md
 * and docs/lights.md.
 */

/**
 * A whole number would otherwise reach GLSL as an int and turn the surrounding arithmetic into
 * integer arithmetic, which is a silent wrong answer rather than a compile error.
 */
export function glslFloat(n: number): string {
  return Number.isInteger(n) ? `${n}.0` : String(n);
}
