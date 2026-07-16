import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";
import { traceMark } from "@/services/performanceTrace";

traceMark("app.javascript_boot_started");
createRoot(document.getElementById("root")!).render(<App />);
traceMark("app.react_render_called");
