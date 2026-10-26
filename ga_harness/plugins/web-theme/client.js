(function(jsxRuntime, react, reactDom, sdk) {
  "use strict";
  const themes = ["light", "dark", "warm"];
  function Theme({ api }) {
    const [container] = react.useState(() => document.createElement("span"));
    const [theme, setTheme] = react.useState(() => {
      const value = sdk.saved("gah-theme") || document.documentElement.dataset.theme || "light";
      return themes.includes(value) ? value : "light";
    });
    react.useLayoutEffect(() => {
      api.slot("header", container);
      return () => {
        container.remove();
        delete document.documentElement.dataset.theme;
      };
    }, [api, container]);
    react.useLayoutEffect(() => {
      document.documentElement.dataset.theme = theme;
    }, [theme]);
    return reactDom.createPortal(/* @__PURE__ */ jsxRuntime.jsxs("select", { id: "theme", "aria-label": sdk.T("主题", "Theme"), value: theme, onChange: (event) => {
      setTheme(event.target.value);
      sdk.save("gah-theme", event.target.value);
    }, children: [
      /* @__PURE__ */ jsxRuntime.jsx("option", { value: "light", children: sdk.T("浅色", "Light") }),
      /* @__PURE__ */ jsxRuntime.jsx("option", { value: "dark", children: sdk.T("深色", "Dark") }),
      /* @__PURE__ */ jsxRuntime.jsx("option", { value: "warm", children: sdk.T("暖色", "Warm") })
    ] }), container);
  }
  sdk.defineReact("web-theme", Theme);
})(GAH.jsxRuntime, GAH.React, GAH.ReactDOM, GAH);
