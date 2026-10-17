/**
 * The scene manifest.
 *
 * Adding a scene is one file plus one line here. That is the whole mechanism, and it exists so that a new
 * visual idea never requires editing the engine core — the spine does not grow a special case for each
 * new look. See `docs/EXTENDING.md` recipe 1.
 *
 * Order does not matter: registration happens for every entry before the first frame.
 */

export const sceneManifest = [
  import("./intro.js"),
  import("./grid.js"),
  import("./burst.js"),
  import("./outro.js"),
];

export default sceneManifest;
