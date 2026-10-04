// The Board: cards in three columns, saved to board/board.json. The file is handled as plain JSON so
// fields the core doesn't use are kept as they were.
use std::collections::HashSet;
use std::fs;

use serde_json::{json, Map, Value};

use crate::markdown::plain_text;
use crate::meetings::{is_suggested, load_meetings, owner_names, Meeting, COULD_NOT_READ};
use crate::paths::Workspace;
use crate::store::write_json_atomic;
use crate::{js, Error};

const FILE: &str = "board/board.json";
const COLUMN_IDS: [&str; 3] = ["todo", "doing", "done"];
const MAX_TITLE: usize = 500;
const MAX_OWNER: usize = 120;

fn columns() -> Value {
    json!([{ "id": "todo", "name": "To do" }, { "id": "doing", "name": "Doing" }, { "id": "done", "name": "Done" }])
}

fn err(status: u16, message: impl Into<String>) -> Error {
    Error::Status(status, message.into())
}

fn is_column(v: Option<&Value>) -> bool {
    v.and_then(Value::as_str).is_some_and(|c| COLUMN_IDS.contains(&c))
}

fn str_of<'a>(card: &'a Value, key: &str) -> Option<&'a str> {
    card.get(key).and_then(Value::as_str)
}

// Checks the whole file. If any part is off, the board is shown as unreadable and nothing is written,
// so a hand-edited file is never overwritten with a guess.
fn validate(board: &Value) -> Vec<String> {
    let Some(obj) = board.as_object() else { return vec!["the file is not a JSON object".into()] };
    let mut problems = Vec::new();
    let cards = obj.get("cards").and_then(Value::as_array);
    if cards.is_none() { problems.push("\"cards\" is not a list".into()); }
    if let Some(d) = obj.get("deletedImports") {
        if !d.as_array().is_some_and(|a| a.iter().all(Value::is_string)) { problems.push("\"deletedImports\" is not a list of keys".into()); }
    }
    let mut ids = HashSet::new();
    for (i, c) in cards.into_iter().flatten().enumerate() {
        let at = format!("card {}", i + 1);
        if c.is_array() { problems.push(format!("{at} is a list, not an object with an id, column and title")); continue; }
        if !c.is_object() { problems.push(format!("{at} is not an object")); continue; }
        match str_of(c, "id") {
            Some(id) if !id.is_empty() => {
                if !ids.insert(id.to_string()) { problems.push(format!("{at} repeats id {id}")); }
            }
            _ => problems.push(format!("{at} has no id")),
        }
        if !is_column(c.get("column")) { problems.push(format!("{at} has an unknown column \"{}\"", js::string(c.get("column")))); }
        if !str_of(c, "title").is_some_and(|t| !js::trim(t).is_empty()) { problems.push(format!("{at} has no title")); }
        let source = str_of(c, "source");
        if source != Some("import") && source != Some("manual") { problems.push(format!("{at} has an unknown source \"{}\"", js::string(c.get("source")))); }
        if source == Some("import") && !c.get("key").is_some_and(Value::is_string) { problems.push(format!("{at} is imported but has no key")); }
    }
    problems
}

pub fn read_board(ws: &Workspace) -> Result<Value, Error> {
    let abs = ws.resolve(FILE)?;
    if !abs.exists() {
        let board = json!({ "version": 1, "cards": [], "deletedImports": [] });
        write_json_atomic(ws, FILE, &board)?;
        return Ok(board);
    }
    let unreadable = |why: String| err(409, format!("{FILE} {COULD_NOT_READ}: {why}. Nothing will be saved until it is fixed."));
    let text = fs::read(&abs).map_err(|e| unreadable(e.to_string()))?;
    let mut board: Value = serde_json::from_str(&String::from_utf8_lossy(&text)).map_err(|e| unreadable(e.to_string()))?;
    let problems = validate(&board);
    if !problems.is_empty() { return Err(unreadable(problems.into_iter().take(3).collect::<Vec<_>>().join("; "))); }
    let obj = board.as_object_mut().unwrap();
    if obj.get("deletedImports").is_none_or(Value::is_null) { obj.insert("deletedImports".into(), json!([])); }
    Ok(board)
}

fn cards(board: &Value) -> &Vec<Value> {
    board["cards"].as_array().unwrap()
}

fn cards_mut(board: &mut Value) -> &mut Vec<Value> {
    board["cards"].as_array_mut().unwrap()
}

// Owners per card, by the same rule as the Meetings page. Computed for display; never saved.
fn owners(board: &Value) -> (Value, Value) {
    let mut by_id = Map::new();
    let mut all: Vec<String> = Vec::new();
    for c in cards(board) {
        let names = if js::truthy(c.get("owner")) { owner_names(&js::string(c.get("owner"))) } else { Vec::new() };
        for n in &names { if !all.contains(n) { all.push(n.clone()); } }
        by_id.insert(str_of(c, "id").unwrap_or_default().to_string(), json!(names));
    }
    all.sort_by(|a, b| js::cmp_utf16(a, b));
    (Value::Object(by_id), json!(all))
}

fn view(board: Value, extra: Map<String, Value>) -> Value {
    let (owners_by_id, owners) = owners(&board);
    let mut out = Map::new();
    out.insert("board".into(), board);
    out.insert("ownersById".into(), owners_by_id);
    out.insert("owners".into(), owners);
    out.extend(extra);
    Value::Object(out)
}

fn update(ws: &Workspace, f: impl FnOnce(&mut Value) -> Result<Map<String, Value>, Error>) -> Result<Value, Error> {
    let mut board = read_board(ws)?;
    let extra = f(&mut board)?;
    write_json_atomic(ws, FILE, &board)?;
    Ok(view(board, extra))
}

/// Puts `card` into `column` just before the card `before_id`, at the top when `at_top`, else at the end.
fn place(board: &mut Value, mut card: Value, column: &str, before_id: Option<&str>, at_top: bool) -> Result<Value, Error> {
    card["column"] = json!(column);
    let cards = cards_mut(board);
    let in_column: Vec<usize> = (0..cards.len()).filter(|&i| str_of(&cards[i], "column") == Some(column)).collect();
    let at = if let Some(before) = before_id.filter(|b| !b.is_empty()) {
        match in_column.iter().find(|&&i| str_of(&cards[i], "id") == Some(before)) {
            Some(&i) => i,
            None => return Err(err(409, "The drop position is no longer on the board. Reload to see the current board.")),
        }
    } else if at_top && !in_column.is_empty() {
        in_column[0]
    } else {
        in_column.last().map(|i| i + 1).unwrap_or(cards.len())
    };
    cards.insert(at, card.clone());
    Ok(card)
}

fn find_card(board: &Value, id: &str) -> Result<usize, Error> {
    cards(board).iter().position(|c| str_of(c, "id") == Some(id))
        .ok_or_else(|| err(404, "That card is no longer on the board. Reload to see the current board."))
}

fn clean_text(value: Option<&Value>, name: &str, max: usize, required: bool) -> Result<String, Error> {
    static SPACE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| js::re(r"\s+", ""));
    let s = match value { Some(Value::String(s)) => js::trim(&SPACE.replace_all(s, " ")).to_string(), _ => String::new() };
    if required && s.is_empty() { return Err(err(400, format!("{name} is required"))); }
    if js::len(&s) > max { return Err(err(400, format!("{name} is longer than {max} characters"))); }
    Ok(s)
}

fn meeting_ref(file: Option<&Value>, meetings: &[Meeting]) -> Result<(Value, Value), Error> {
    if !js::truthy(file) { return Ok((Value::Null, Value::Null)); }
    match meetings.iter().find(|m| Some(m.file.as_str()) == file.and_then(Value::as_str)) {
        Some(m) => Ok((json!(m.file), json!(m.date))),
        None => Err(err(400, format!("Unknown meeting: {}", js::string(file)))),
    }
}

fn now() -> String {
    chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

fn null_if_empty(s: String) -> Value {
    if s.is_empty() { Value::Null } else { Value::String(s) }
}

// ---------- operations ----------

pub fn import_action_items(ws: &Workspace, include_suggested: bool) -> Result<Value, Error> {
    let meetings = load_meetings(ws)?;
    update(ws, |board| {
        let mut on_board: HashSet<String> = cards(board).iter()
            .filter(|c| str_of(c, "source") == Some("import"))
            .filter_map(|c| str_of(c, "key").map(str::to_string)).collect();
        let deleted: HashSet<String> = board["deletedImports"].as_array().unwrap().iter().filter_map(|k| k.as_str().map(str::to_string)).collect();
        let (mut added, mut already, mut prev_deleted, mut left_out) = (0, 0, 0, 0);
        // Oldest meeting first, in item order, so the To do column reads chronologically.
        for m in meetings.iter().rev() {
            for a in &m.action_items {
                let key = format!("{}#{}", m.file, js::number_to_string(a.num));
                let suggested = is_suggested(&a.text, &a.status);
                if on_board.contains(&key) { already += 1; continue; }
                if deleted.contains(&key) { prev_deleted += 1; continue; }
                if suggested && !include_suggested { left_out += 1; continue; }
                cards_mut(board).push(json!({
                    "id": uuid::Uuid::new_v4().to_string(),
                    "column": "todo",
                    "source": "import",
                    "key": key,
                    "title": plain_text(&a.text),
                    "owner": null_if_empty(plain_text(&a.owner)),
                    "meeting": m.file,
                    "meetingDate": m.date,
                    "suggested": suggested,
                    "created": now(),
                }));
                on_board.insert(key);
                added += 1;
            }
        }
        let warnings: Vec<_> = meetings.iter().flat_map(|m| m.warnings.clone()).collect();
        let mut extra = Map::new();
        extra.insert("counts".into(), json!({ "added": added, "alreadyOnBoard": already, "previouslyDeleted": prev_deleted, "suggestedLeftOut": left_out }));
        extra.insert("warnings".into(), json!(warnings));
        Ok(extra)
    })
}

fn one(key: &str, v: Value) -> Map<String, Value> {
    let mut m = Map::new();
    m.insert(key.into(), v);
    m
}

pub fn add_card(ws: &Workspace, input: &Map<String, Value>) -> Result<Value, Error> {
    let meetings = load_meetings(ws)?;
    update(ws, |board| {
        let title = clean_text(input.get("title"), "Title", MAX_TITLE, true)?;
        let owner = clean_text(input.get("owner"), "Owner", MAX_OWNER, false)?;
        let (meeting, meeting_date) = meeting_ref(input.get("meeting"), &meetings)?;
        let card = json!({
            "id": uuid::Uuid::new_v4().to_string(),
            "source": "manual",
            "title": title,
            "owner": null_if_empty(owner),
            "meeting": meeting,
            "meetingDate": meeting_date,
            "created": now(),
        });
        // Cards added by hand go to the top of their column.
        let column = if is_column(input.get("column")) { input["column"].as_str().unwrap() } else { "todo" };
        let card = place(board, card, column, None, true)?;
        Ok(one("card", card))
    })
}

pub fn edit_card(ws: &Workspace, id: &str, input: &Map<String, Value>) -> Result<Value, Error> {
    let meetings = load_meetings(ws)?;
    update(ws, |board| {
        let i = find_card(board, id)?;
        if str_of(&cards(board)[i], "source") != Some("manual") {
            return Err(err(403, "Imported cards come from the meeting notes and can’t be edited. Move or delete them instead."));
        }
        let title = clean_text(input.get("title"), "Title", MAX_TITLE, true)?;
        let owner = clean_text(input.get("owner"), "Owner", MAX_OWNER, false)?;
        let (meeting, meeting_date) = meeting_ref(input.get("meeting"), &meetings)?;
        let card = &mut cards_mut(board)[i];
        card["title"] = json!(title);
        card["owner"] = null_if_empty(owner);
        card["meeting"] = meeting;
        card["meetingDate"] = meeting_date;
        card["updated"] = json!(now());
        Ok(one("card", card.clone()))
    })
}

/// Moves a card to `column`, before the card `beforeId` (end of the column if none). Using a card id
/// rather than a position keeps drops right when the page is only showing some of the cards.
pub fn move_card(ws: &Workspace, id: &str, input: &Map<String, Value>) -> Result<Value, Error> {
    let column = input.get("column");
    if !is_column(column) { return Err(err(400, format!("Unknown column \"{}\"", js::string(column)))); }
    let column = column.unwrap().as_str().unwrap();
    let before_id = match input.get("beforeId") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => Some(s.as_str()),
        Some(_) => return Err(err(400, "Invalid drop position")),
    };
    update(ws, |board| {
        let i = find_card(board, id)?;
        if before_id == Some(id) { return Ok(one("card", cards(board)[i].clone())); }
        let mut card = cards_mut(board).remove(i);
        if str_of(&card, "column") != Some(column) { card["updated"] = json!(now()); }
        let card = place(board, card, column, before_id, false)?;
        Ok(one("card", card))
    })
}

pub fn delete_card(ws: &Workspace, id: &str) -> Result<Value, Error> {
    update(ws, |board| {
        let i = find_card(board, id)?;
        let card = cards_mut(board).remove(i);
        // A deleted imported card stays deleted: the next import skips its key.
        if str_of(&card, "source") == Some("import") {
            let key = card["key"].clone();
            let deleted = board["deletedImports"].as_array_mut().unwrap();
            if !deleted.contains(&key) { deleted.push(key); }
        }
        Ok(one("card", card))
    })
}

pub fn board_view(ws: &Workspace) -> Result<Value, Error> {
    let meetings = load_meetings(ws)?;
    let board = read_board(ws)?;
    let mut extra = Map::new();
    extra.insert("columns".into(), columns());
    extra.insert("meetings".into(), json!(meetings.iter().map(|m| json!({ "file": m.file, "date": m.date, "people": m.people })).collect::<Vec<_>>()));
    Ok(view(board, extra))
}
