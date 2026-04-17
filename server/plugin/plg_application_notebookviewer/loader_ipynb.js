import { createElement } from "../../lib/skeleton/index.js";
import rxjs, { effect } from "../../lib/rx.js";
import ajax from "../../lib/ajax.js";
import { loadJS, loadCSS } from "../../helpers/loader.js";
import { transition } from "../../pages/viewerpage/common.js";
import ctrlDownloader, { init as initDownloader } from "../../pages/viewerpage/application_downloader.js";
import { createLoader } from "../../components/loader.js";

await init();

export default async function(render, { getDownloadUrl, getFilename, acl$ }) {
    const $page = createElement(`
        <div class="component_ipynb"></div>
    `);
    render($page);

    const cancelLoader = createLoader($page);
    effect(ajax({ url: getDownloadUrl(), responseType: "text" }).pipe(
        cancelLoader,
        rxjs.mergeMap(async ({ responseText, response }) => {
            const raw = typeof responseText === "string" ? responseText : response;
            const notebook = JSON.parse(raw);
            renderNotebook(notebook, $page);
        }),
        rxjs.catchError(() => ctrlDownloader(render, { acl$, getFilename, getDownloadUrl, hasMenubar: false })),
    ));
}

function renderNotebook(notebook, $page) {
    if (!window.ipynb2html || typeof window.ipynb2html.render !== "function") {
        throw new Error("ipynb2html runtime is not available");
    }

    const $notebook = window.ipynb2html.render(notebook);
    $notebook.classList.add("component_ipynb-notebook");
    $page.innerHTML = "";
    $page.appendChild($notebook);
    $page.parentElement.classList.add("scroll-y");
    transition($page);
}

function init() {
    return Promise.all([
        loadCSS(import.meta.url, "./loader_ipynb.css"),
        loadCSS(import.meta.url, "./lib/vendor/notebook.min.css"),
        loadCSS(import.meta.url, "./lib/vendor/katex.min.css"),
        loadCSS(import.meta.url, "./lib/vendor/highlight.min.css"),
        initDownloader(),
        loadJS(import.meta.url, "./lib/vendor/ipynb2html-full.min.js"),
    ]);
}
