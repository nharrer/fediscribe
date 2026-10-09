// SPDX-License-Identifier: GPL-3.0-or-later
// Text field with a searchable drop-down list (ARIA combobox pattern). The
// field accepts any text; the list only offers suggestions.

import { filterModels } from '../shared/search.js';

// input:    <input role="combobox">
// list:     <ul role="listbox">
// getItems: () => [{ id, name }]
// onCommit: (value) => void, called when a value is chosen or typed in
// emptyText: () => string shown when nothing matches
export function setupCombobox({ input, list, getItems, onCommit, emptyText }) {
    let shown = [];
    let active = -1;
    // The last committed value, restored by Escape.
    let original = input.value;
    // Until the user types, the full list is shown (the field contains the
    // current model, which would otherwise filter the list down to itself).
    let filtering = false;

    function optionId(index) {
        return `${list.id}-option-${index}`;
    }

    function setActive(index) {
        list.querySelector('[aria-selected="true"]')?.setAttribute('aria-selected', 'false');
        active = index;
        if (index < 0) {
            input.removeAttribute('aria-activedescendant');
            return;
        }
        const option = document.getElementById(optionId(index));
        option.setAttribute('aria-selected', 'true');
        input.setAttribute('aria-activedescendant', option.id);
        option.scrollIntoView({ block: 'nearest' });
    }

    function render() {
        const items = getItems();
        shown = filtering ? filterModels(items, input.value) : items;
        const elements = shown.map((item, index) => {
            const option = document.createElement('li');
            option.id = optionId(index);
            option.setAttribute('role', 'option');
            option.setAttribute('aria-selected', 'false');
            option.dataset.index = String(index);
            const id = document.createElement('span');
            id.className = 'combobox-id';
            id.textContent = item.id;
            option.append(id);
            if (item.name && item.name !== item.id) {
                const name = document.createElement('span');
                name.className = 'combobox-name';
                name.textContent = item.name;
                option.append(name);
            }
            return option;
        });
        if (!elements.length && items.length) {
            const empty = document.createElement('li');
            empty.className = 'combobox-empty';
            empty.textContent = emptyText();
            elements.push(empty);
        }
        list.replaceChildren(...elements);
        active = -1;
        input.removeAttribute('aria-activedescendant');
        const current = filtering ? -1 : shown.findIndex((item) => item.id === input.value);
        if (current >= 0) {
            setActive(current);
        }
    }

    // filter: false shows the full list (on focus or click), true filters by
    // the text in the field (while typing).
    function open(filter) {
        filtering = filter;
        if (!getItems().length) {
            return;
        }
        render();
        list.hidden = false;
        input.setAttribute('aria-expanded', 'true');
    }

    function close() {
        list.hidden = true;
        input.setAttribute('aria-expanded', 'false');
        input.removeAttribute('aria-activedescendant');
        active = -1;
    }

    function commit(value) {
        input.value = value.trim();
        close();
        if (input.value !== original) {
            original = input.value;
            onCommit(input.value);
        }
    }

    input.addEventListener('focus', () => {
        // The value may have been set from outside (provider change).
        original = input.value;
        open(false);
    });
    input.addEventListener('click', () => {
        if (list.hidden) {
            open(false);
        }
    });
    input.addEventListener('input', () => open(true));
    input.addEventListener('blur', () => commit(input.value));
    input.addEventListener('keydown', (event) => {
        switch (event.key) {
        case 'ArrowDown':
        case 'ArrowUp': {
            event.preventDefault();
            if (list.hidden) {
                open(false);
                return;
            }
            if (!shown.length) {
                return;
            }
            const step = event.key === 'ArrowDown' ? 1 : -1;
            setActive((active + step + shown.length) % shown.length);
            break;
        }
        case 'Enter':
            event.preventDefault();
            commit(active >= 0 && !list.hidden ? shown[active].id : input.value);
            break;
        case 'Escape':
            if (!list.hidden) {
                event.preventDefault();
                input.value = original;
                close();
            }
            break;
        case 'Tab':
            if (active >= 0 && !list.hidden) {
                commit(shown[active].id);
            }
            break;
        default:
            break;
        }
    });

    // mousedown instead of click: keeps the focus in the field, so the blur
    // handler does not commit the typed text first.
    list.addEventListener('mousedown', (event) => {
        event.preventDefault();
        const option = event.target.closest('[role="option"]');
        if (option) {
            commit(shown[Number(option.dataset.index)].id);
        }
    });

    return {
        // Re-renders an open list after the items changed.
        refresh() {
            if (!list.hidden) {
                render();
            }
        },
        close,
    };
}
