// Entry point. <script type="module"> defers by default, so the DOM is parsed
// before this runs — #root resolves and boot() fires after parse.
import { boot } from "./router.js";

boot();
