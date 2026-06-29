// Runs at document_start in MAIN world. Installs a minimal
// React DevTools hook so React's mount-time checkDCE+inject() finds
// it, populates renderers, and onCommitFiberRoot accumulates roots.
// Without this, react_tree / react_inspect see no fibers because
// React skips its instrumentation when no hook is present.
(function () {
  if (typeof window === "undefined") return;
  if (window.__REACT_DEVTOOLS_GLOBAL_HOOK__) return;
  const renderers = new Map();
  const fiberRootsByRenderer = new Map();
  let nextRendererId = 1;
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    renderers,
    inject: function (renderer) {
      const id = nextRendererId++;
      renderers.set(id, renderer);
      fiberRootsByRenderer.set(id, new Set());
      return id;
    },
    getFiberRoots: function (rendererID) {
      return fiberRootsByRenderer.get(rendererID) || new Set();
    },
    onCommitFiberRoot: function (rendererID, root) {
      const roots = fiberRootsByRenderer.get(rendererID);
      if (roots) roots.add(root);
    },
    onCommitFiberUnmount: function () {},
    onPostCommitFiberRoot: function () {},
    supportsFiber: true,
    checkDCE: function () {},
  };
})();
