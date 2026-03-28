// PM2 wrapper for relay.ts
// PM2's ProcessContainerForkBun uses require() which can't handle top-level await.
// Dynamic import() without await keeps this synchronous for require().
import("./relay.ts");
