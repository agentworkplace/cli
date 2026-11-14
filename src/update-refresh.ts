// The detached process a command starts when its update cache is a day old.
// It only asks npm for the latest release and records it; it prints nothing.
import { refreshUpdateCache } from "./update-check.js";

const cachePath = process.argv[2];
await refreshUpdateCache(cachePath === undefined ? {} : { cachePath });
