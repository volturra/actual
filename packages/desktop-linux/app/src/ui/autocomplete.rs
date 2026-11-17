//! A text entry with a popup list of matches, used for payees and
//! categories. Typing filters; Up/Down/Enter or a click picks a match. The
//! entry also accepts free text (a new payee name).

use std::cell::RefCell;
use std::rc::Rc;

use gtk::prelude::*;

#[derive(Clone, Debug, Default)]
pub struct Choice {
    pub id: String,
    pub label: String,
    /// Shown dimmed after the label (e.g. the category's group).
    pub detail: String,
    /// Not offered while typing, but still shown when a transaction already
    /// uses it (a hidden category, a closed account's transfer payee).
    pub hidden: bool,
}

/// The id of the "Create …" row, which keeps the typed text as a new value.
const CREATE_ID: &str = "\u{0}create";

struct Inner {
    entry: gtk::Entry,
    popover: gtk::Popover,
    list: gtk::ListBox,
    choices: RefCell<Vec<Choice>>,
    shown: RefCell<Vec<Choice>>,
    selected: RefCell<Option<Choice>>,
    suppress: std::cell::Cell<bool>,
    allow_create: std::cell::Cell<bool>,
    on_pick: RefCell<Option<Box<dyn Fn(&Choice)>>>,
}

#[derive(Clone)]
pub struct Autocomplete(Rc<Inner>);

impl Autocomplete {
    pub fn new(placeholder: &str) -> Autocomplete {
        let entry = gtk::Entry::builder().placeholder_text(placeholder).hexpand(true).build();
        let list = gtk::ListBox::new();
        list.set_selection_mode(gtk::SelectionMode::Single);
        let scroller = gtk::ScrolledWindow::builder()
            .child(&list)
            .propagate_natural_height(true)
            .max_content_height(280)
            .min_content_width(260)
            .hscrollbar_policy(gtk::PolicyType::Never)
            .build();
        let popover = gtk::Popover::builder().child(&scroller).autohide(false).has_arrow(false).build();
        popover.set_parent(&entry);
        popover.set_position(gtk::PositionType::Bottom);
        let inner = Rc::new(Inner {
            entry,
            popover,
            list,
            choices: RefCell::new(Vec::new()),
            shown: RefCell::new(Vec::new()),
            selected: RefCell::new(None),
            suppress: std::cell::Cell::new(false),
            allow_create: std::cell::Cell::new(false),
            on_pick: RefCell::new(None),
        });
        let ac = Autocomplete(inner);

        let weak = Rc::downgrade(&ac.0);
        ac.0.entry.connect_changed(move |_| {
            if let Some(i) = weak.upgrade() {
                let ac = Autocomplete(i);
                if ac.0.suppress.get() {
                    return;
                }
                *ac.0.selected.borrow_mut() = None;
                ac.refilter(true);
            }
        });
        let weak = Rc::downgrade(&ac.0);
        ac.0.list.connect_row_activated(move |_, row| {
            if let Some(i) = weak.upgrade() {
                Autocomplete(i).pick_index(row.index() as usize);
            }
        });
        let key = gtk::EventControllerKey::new();
        key.set_propagation_phase(gtk::PropagationPhase::Capture);
        let weak = Rc::downgrade(&ac.0);
        key.connect_key_pressed(move |_, keyval, _, _| {
            let Some(i) = weak.upgrade() else { return glib::Propagation::Proceed };
            let ac = Autocomplete(i);
            if !ac.0.popover.is_visible() {
                if keyval == gtk::gdk::Key::Down {
                    ac.refilter(true);
                    return glib::Propagation::Stop;
                }
                return glib::Propagation::Proceed;
            }
            let n = ac.0.shown.borrow().len() as i32;
            let cur = ac.0.list.selected_row().map(|r| r.index()).unwrap_or(-1);
            match keyval {
                gtk::gdk::Key::Down => {
                    if let Some(r) = ac.0.list.row_at_index((cur + 1).min(n - 1)) {
                        ac.0.list.select_row(Some(&r));
                    }
                    glib::Propagation::Stop
                }
                gtk::gdk::Key::Up => {
                    if let Some(r) = ac.0.list.row_at_index((cur - 1).max(0)) {
                        ac.0.list.select_row(Some(&r));
                    }
                    glib::Propagation::Stop
                }
                gtk::gdk::Key::Return | gtk::gdk::Key::KP_Enter | gtk::gdk::Key::Tab => {
                    if cur >= 0 {
                        ac.pick_index(cur as usize);
                    } else {
                        ac.0.popover.popdown();
                    }
                    if keyval == gtk::gdk::Key::Tab {
                        glib::Propagation::Proceed
                    } else {
                        glib::Propagation::Stop
                    }
                }
                gtk::gdk::Key::Escape => {
                    ac.0.popover.popdown();
                    glib::Propagation::Stop
                }
                _ => glib::Propagation::Proceed,
            }
        });
        ac.0.entry.add_controller(key);
        let focus = gtk::EventControllerFocus::new();
        let weak = Rc::downgrade(&ac.0);
        focus.connect_leave(move |_| {
            if let Some(i) = weak.upgrade() {
                let i2 = i.clone();
                // Let a click in the list land before hiding it.
                glib::timeout_add_local_once(std::time::Duration::from_millis(150), move || {
                    if !focused(&i2.entry) && !focused(&i2.list) {
                        i2.popover.popdown();
                    }
                });
            }
        });
        ac.0.entry.add_controller(focus);
        ac
    }

    pub fn widget(&self) -> &gtk::Entry {
        &self.0.entry
    }

    pub fn set_choices(&self, choices: Vec<Choice>) {
        *self.0.choices.borrow_mut() = choices;
    }

    /// Offers a "Create “…”" row for text that matches no choice exactly.
    pub fn set_allow_create(&self, allow: bool) {
        self.0.allow_create.set(allow);
    }

    pub fn choices(&self) -> Vec<Choice> {
        self.0.choices.borrow().clone()
    }

    pub fn connect_pick(&self, f: impl Fn(&Choice) + 'static) {
        *self.0.on_pick.borrow_mut() = Some(Box::new(f));
    }

    /// The picked choice, if the text still matches it.
    pub fn selected(&self) -> Option<Choice> {
        self.0.selected.borrow().clone()
    }

    pub fn text(&self) -> String {
        self.0.entry.text().to_string()
    }

    /// Sets the value without opening the popup.
    pub fn set(&self, choice: Option<&Choice>) {
        self.0.suppress.set(true);
        match choice {
            Some(c) => {
                self.0.entry.set_text(&c.label);
                *self.0.selected.borrow_mut() = Some(c.clone());
            }
            None => {
                self.0.entry.set_text("");
                *self.0.selected.borrow_mut() = None;
            }
        }
        self.0.suppress.set(false);
        self.0.popover.popdown();
    }

    pub fn set_by_id(&self, id: Option<&str>) {
        let c = id.and_then(|id| self.0.choices.borrow().iter().find(|c| c.id == id).cloned());
        self.set(c.as_ref());
    }

    fn refilter(&self, show: bool) {
        let text = self.0.entry.text().trim().to_string();
        let q = text.to_lowercase();
        let mut shown: Vec<Choice> = self
            .0
            .choices
            .borrow()
            .iter()
            .filter(|c| !c.hidden && (q.is_empty() || c.label.to_lowercase().contains(&q) || c.detail.to_lowercase().contains(&q)))
            .take(50)
            .cloned()
            .collect();
        // Prefer the first name that starts with what was typed; if none
        // does, the "Create" row is the default so a new name isn't
        // silently replaced by a longer existing one.
        let starts = shown.iter().position(|c| c.label.to_lowercase().starts_with(&q));
        let mut preselect = starts.unwrap_or(0);
        if self.0.allow_create.get() && !q.is_empty() && !shown.iter().any(|c| c.label.to_lowercase() == q) {
            shown.insert(0, Choice { id: CREATE_ID.into(), label: format!("Create “{text}”"), ..Default::default() });
            preselect = starts.map(|i| i + 1).unwrap_or(0);
        }
        while let Some(row) = self.0.list.row_at_index(0) {
            self.0.list.remove(&row);
        }
        for c in &shown {
            let b = gtk::Box::new(gtk::Orientation::Horizontal, 8);
            b.set_margin_start(6);
            b.set_margin_end(6);
            b.set_margin_top(3);
            b.set_margin_bottom(3);
            b.append(&gtk::Label::builder().label(&c.label).xalign(0.0).hexpand(true).build());
            if !c.detail.is_empty() {
                let d = gtk::Label::new(Some(&c.detail));
                d.add_css_class("dim-label");
                b.append(&d);
            }
            self.0.list.append(&b);
        }
        if let Some(r) = self.0.list.row_at_index(preselect as i32) {
            if !q.is_empty() {
                self.0.list.select_row(Some(&r));
            }
        }
        let has = !shown.is_empty();
        *self.0.shown.borrow_mut() = shown;
        if show && has && focused(&self.0.entry) {
            self.0.popover.popup();
        } else if !has {
            self.0.popover.popdown();
        }
    }

    fn pick_index(&self, idx: usize) {
        let Some(c) = self.0.shown.borrow().get(idx).cloned() else { return };
        if c.id == CREATE_ID {
            // Keep the typed text as a new name.
            *self.0.selected.borrow_mut() = None;
            self.0.popover.popdown();
            self.0.entry.set_position(-1);
            return;
        }
        self.set(Some(&c));
        self.0.entry.set_position(-1);
        if let Some(f) = self.0.on_pick.borrow().as_ref() {
            f(&c);
        }
    }
}

/// Whether keyboard focus is in `w` or a child (an Entry's text lives in an
/// inner widget, so `has_focus` on the Entry itself is always false).
fn focused(w: &impl IsA<gtk::Widget>) -> bool {
    w.state_flags().contains(gtk::StateFlags::FOCUS_WITHIN)
}

impl Drop for Inner {
    fn drop(&mut self) {
        self.popover.unparent();
    }
}
