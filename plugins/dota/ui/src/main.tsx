import { createRoot } from "react-dom/client";
import { Dota } from "./App";
import "../../../../apps/companion/src/components/ui/ui.css";
import "./style.css";
import { retryFailedCdnImages } from "./imageRetry";
retryFailedCdnImages();
createRoot(document.getElementById("root")!).render(<Dota/>);
