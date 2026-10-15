window.__ModuleLoader__.load({
  id: "dsgs-statusline",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    // The module loader provides these; the shape is copied from the harness's own GoalBar
    // (`dsh-client-ui-goal/lib/client.js`), which is the client that already docks a bar above the
    // composer through `ctx.slots.inject("conversation.input.dock", …)`.
    const jsxRuntime = require("react/jsx-runtime");

    /**
     * The status line, as a bar docked above the composer.
     *
     * Data comes from the session projection the server half registers (`dgsStatusline` → `{ line }`),
     * read the same way the GoalBar reads its own: `session.projections.faceOf(key).getSnapshot()`.
     * Every step is defensive: the projection may not exist yet, and a bar that throws would take
     * the composer down with it.
     *
     * @param {{session?: object, value?: {line?: string}}} props - slot props
     * @returns {object | null} the bar, or null when there is nothing to show
     */
    function DgsStatuslineBar(props) {
      const direct = props?.value?.line;
      const snapshot = props?.session?.projections?.faceOf?.("dgsStatusline")?.getSnapshot?.();
      const line = typeof direct === "string" && direct.length > 0 ? direct : snapshot?.line;
      if (typeof line !== "string" || line.length === 0) return null;
      return jsxRuntime.jsx("div", { className: "dsgs-statusline", children: line });
    }

    function apply(ctx) {
      ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({
        name: "conversation.input.dock",
        id: "dsgs-statusline",
        order: 20,
        inject: (sessionId) => ({ sessionId }),
      }, DgsStatuslineBar));
    }

    exports.name = "dsgs-statusline";
    exports.inject = ["slots"];
    exports.DgsStatuslineBar = DgsStatuslineBar;
    exports.apply = apply;
    return module.exports;
  },
});

