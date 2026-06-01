import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./components/App";
import { installDevMock } from "./devMock";
import "./styles/app.css";

installDevMock();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
