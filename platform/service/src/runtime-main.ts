const processKind = process.env.DOP_PROCESS_KIND;

if (processKind === "intake") {
  await import("./main.js");
} else if (processKind === "preservation") {
  await import("./document-preservation-daemon-main.js");
} else if (processKind === "classification") {
  await import("./classification-daemon-main.js");
} else if (processKind === "reminder-automation") {
  await import("./reminder-automation-main.js");
} else {
  throw new Error("DOP_PROCESS_KIND must be intake, preservation, classification, or reminder-automation");
}
