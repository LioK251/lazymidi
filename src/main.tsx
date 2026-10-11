import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import Overlay from "./Overlay";
import Visualizer from "./Visualizer";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {new URLSearchParams(location.search).get("overlay")==="visualizer"?<Visualizer/>:new URLSearchParams(location.search).has("overlay") ? <Overlay kind={new URLSearchParams(location.search).get("overlay")!}/> : <App />}
  </React.StrictMode>,
);
