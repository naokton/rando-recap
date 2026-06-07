// Entry point. <script type="module"> defers by default, so the DOM is parsed
// before this runs — no DOMContentLoaded needed.
import { boot } from "./router.js";

boot();
