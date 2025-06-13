import { createElement } from "../../lib/skeleton/index.js";
import { extname } from "../../lib/path.js";
import rxjs, { effect, preventDefault, } from "../../lib/rx.js";
import { qs } from "../../lib/dom.js";
import { MODAL_RIGHT_BUTTON } from "../../components/modal.js";
import t from "../../locales/index.js";


export default function(render, filename, file, user_info) {
    return document.body.classList.contains("touch-yes")
        ? renderMobile(render, filename, file, user_info)
        : renderDesktop(render, filename, file, user_info);
}

function renderDesktop(render, filename, file, user_info) {
    const $modal = createElement(`
        <div>
            <b>${filename}</b><br/>
            ${"Owner: " + (file.uid === user_info.uid ? "You" : file.uid)}<br/>
            ${"Group: " + (user_info.gids.includes(file.gid) ? user_info.gnames[user_info.gids.indexOf(file.gid)] : file.gid)}<br/><br/>
            Permissions:
            <form style="margin-top: 10px;">
                <div id="checkbox-grid"></div>
                <div class="modal-error-message"></div>
            </form>
        </div>
    `);
    // Create 3x3 checkboxes
    let permissions = permissionsToList(file.perms)
    const gridContainer = qs($modal, '#checkbox-grid');
    // Set this to true or false to enable/disable all checkboxes
    const allDisabled = file.uid !== user_info.uid;

    // Example row titles
    const rowTitles = ['User', 'Group', 'All'];
    const columnLabels = ['Read', 'Write', 'Execute'];

    // Create a table (no borders)
    const table = document.createElement('table');
    table.style.borderCollapse = 'collapse'; // no gaps

    for (let row = 0; row < 3; row++) {
        
        const tr = document.createElement('tr');

        // First cell with row label text
        const labelTd = document.createElement('td');
        labelTd.textContent = rowTitles[row] || `Row ${row + 1}`;
        labelTd.style.paddingRight = '10px';
        tr.appendChild(labelTd);

        // 3 checkbox cells
        for (let col = 0; col < 3; col++) {
            const td = document.createElement('td');
            td.style.paddingRight = '10px';

            // Create checkbox input
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            const cbId = `cb-${row}-${col}`;
            checkbox.id = cbId;
            checkbox.disabled = allDisabled;
            checkbox.checked = permissions[row*3 + col] ?? false;

            // Create label linked to checkbox (clicking label toggles checkbox)
            const label = document.createElement('label');
            label.htmlFor = cbId;
            label.style.userSelect = 'none'; // prevents text selection on click
            label.textContent = columnLabels[col] ?? ""; // or use empty text or any symbol you want
            label.style.cursor = 'pointer';

            // Put checkbox and label inside the cell
            td.appendChild(checkbox);
            td.appendChild(label);

            tr.appendChild(td);
        }

        table.appendChild(tr);
    }
    gridContainer.appendChild(table);


    
    const ret = new rxjs.Subject();
    const pressOK = render($modal, function(id) {
        if (id !== MODAL_RIGHT_BUTTON) {
            return;
        }
        const values =  [];

        for (let row = 0; row < 3; row++) {
            for (let col = 0; col < 3; col++) {
                var cb = document.getElementById(`cb-${row}-${col}`);
                if (cb && cb instanceof HTMLInputElement){
                    values.push(cb?.checked);
                }
            }
        }
        const perm = permissionsToString(values);
        ret.next(perm);
        ret.complete();
    }).bind(null, MODAL_RIGHT_BUTTON);
    
    effect(rxjs.fromEvent(qs($modal, "form"), "submit").pipe(
        preventDefault(),
        rxjs.tap(pressOK),
    ));
    return ret.toPromise();

}

function renderMobile(_, filename, file, user_info) {
    return new Promise((done) => {
        const value = window.prompt(t("Rename as"), filename);
        if (!value || value === filename) {
            return;
        }
        done(value);
    });
}
/**
 * @returns {boolean[]}
 */
function permissionsToList(permissions) {
    let perms = permissions.toString(8);
    let ret = [];
    for (let i = 0; i< 3; i++){
        let group_perms = parseInt(perms[i]);
        for (let j = 2; j>= 0; j--){
            if (group_perms >= 2**j){
                ret.push(true);
                group_perms -= 2**j;
            }
            else{
                ret.push(false);
            }
        }
    }
    return ret;
}

function permissionsToString(list){
    let ret = 0;
    for (let i = 0; i < 3; i++){
        for (let j = 0; j < 3; j++){
            if (list[i*3 + j]){
                ret += 2**(2-j);
            }
        }
        if (i !== 2){
            ret = ret * 10;
        }
    }
    return ret.toString(10);
}