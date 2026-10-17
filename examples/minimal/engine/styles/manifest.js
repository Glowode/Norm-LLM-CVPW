/**
 * The style manifest.
 *
 * A style is registered the same way a scene is: one file plus one line. Adding a second look to a film —
 * or a second film's look to a template — never edits the engine or a scene.
 *
 * A style registered here is available to `project.json::style` and to any shot's `style` field, so one
 * film can mix looks per shot (a title card in one grade, the body in another) without a special case
 * anywhere in the engine.
 */

export const styleManifest = [import("./minimal-paper.js")];

export default styleManifest;
