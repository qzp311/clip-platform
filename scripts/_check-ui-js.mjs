import fs from "node:fs";
const html = fs.readFileSync(
  "D:/clip-platform/clip-platform/apps/clip-agent-desktop/ui/index.html",
  "utf8",
);
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
console.log("script blocks", scripts.length);
for (let i = 0; i < scripts.length; i++) {
  try {
    new Function(scripts[i]);
    console.log("ok", i, "len", scripts[i].length);
  } catch (e) {
    console.log("FAIL", i, e.message);
  }
}
