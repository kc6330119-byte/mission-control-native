// Meeting summaries and the "Tracked items across all meetings" roll-up.
use std::cmp::Ordering;
use std::collections::HashSet;
use std::sync::LazyLock;

use serde_json::{json, Value};

use crate::markdown::{parse_table, plain_text, render_inline, section_lines, split_lines, Row};
use crate::paths::Workspace;
use crate::{js, Error, Warning};

pub const COULD_NOT_READ: &str = "could not read";
const MEETINGS_DIR: &str = "meeting-notes";

// ---------- dates (kept as YYYY-MM-DD strings so time zones never shift them) ----------

fn month_number(name: &str) -> Option<u32> {
    Some(match name {
        "jan" => 1, "feb" => 2, "mar" => 3, "apr" => 4, "may" => 5, "jun" => 6, "jul" => 7, "aug" => 8,
        "sep" | "sept" => 9, "oct" => 10, "nov" => 11, "dec" => 12,
        _ => return None,
    })
}

static MONTH_RE: LazyLock<regex::Regex> = LazyLock::new(|| js::re(
    r"\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sept?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(\d{1,2})(?:,\s*(\d{4}))?\b",
    "",
));
static CELL_YEAR: LazyLock<regex::Regex> = LazyLock::new(|| js::re(r"\b(20\d\d)\b", ""));

pub fn iso(y: i64, m: u32, d: u32) -> String {
    format!("{y:04}-{m:02}-{d:02}")
}

pub fn today_iso() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

/// Whole days from a to b, or None if either is not a real date.
pub fn days_between(a: &str, b: &str) -> Option<i64> {
    Some(js::date_days(b)? - js::date_days(a)?)
}

/// All month-day dates in a cell. A date without a year takes the year written elsewhere in the cell,
/// or else the meeting's year (stepping back a year if that would put it after the meeting). A date
/// that doesn't exist, such as Feb 30, is left out, so the cell reads as "could not read".
pub fn parse_dates(text: &str, meeting_date: &str) -> Vec<String> {
    let cell_year = CELL_YEAR.captures(text).map(|c| c[1].to_string());
    let mut out = Vec::new();
    for m in MONTH_RE.captures_iter(text) {
        let name = m[1].to_lowercase();
        let month = month_number(js::slice_to(&name, 4)).or_else(|| month_number(js::slice_to(&name, 3)));
        let day: u32 = m[2].parse().unwrap();
        let Some(month) = month else { continue };
        if !(1..=31).contains(&day) { continue; }
        let year_text = m.get(3).map(|y| y.as_str().to_string()).or_else(|| cell_year.clone()).unwrap_or_else(|| meeting_date.chars().take(4).collect());
        let year: i64 = js::string_to_number(&year_text) as i64;
        let mut d = iso(year, month, day);
        if m.get(3).is_none() && cell_year.is_none() && d.as_str() > meeting_date { d = iso(year - 1, month, day); }
        if js::is_real_date(&d) { out.push(d); }
    }
    out.sort_by(|a, b| js::cmp_utf16(a, b));
    out
}

// ---------- one meeting ----------

fn header_field(src: &str, name: &str) -> Option<String> {
    let re = js::re(&format!(r"\*\*{}:\*\*\s*([^\n|]+)", regex::escape(name)), "");
    re.captures(src).map(|c| js::trim(&c[1]).to_string())
}

fn split_top_level(s: &str) -> Vec<String> {
    static PARENS: LazyLock<regex::Regex> = LazyLock::new(|| js::re(r"\([^)]*\)", ""));
    let mut parts = Vec::new();
    let mut depth = 0i32;
    let mut cur = String::new();
    for c in s.chars() {
        if c == '(' { depth += 1; }
        if c == ')' { depth -= 1; }
        if c == ',' && depth == 0 { parts.push(std::mem::take(&mut cur)); continue; }
        cur.push(c);
    }
    parts.push(cur);
    parts.iter().map(|p| js::trim(&PARENS.replace_all(p, "")).to_string()).filter(|p| !p.is_empty()).collect()
}

/// Owners are the names outside parentheses: "Riley Brooks (Praveen Iyer secondary)" is owned by Riley.
pub fn owner_names(owner: &str) -> Vec<String> {
    static AND: LazyLock<regex::Regex> = LazyLock::new(|| js::re(r"\s+(?:and|&)\s+", ""));
    split_top_level(&plain_text(owner)).iter()
        .flat_map(|n| AND.split(n).map(|x| js::trim(x).to_string()).collect::<Vec<_>>())
        .filter(|n| !n.is_empty())
        .collect()
}

// Header lines such as "**Date:** May 5, 2026 | **Duration:** 4m 12s", before the first section.
const HEADER_FIELDS: [&str; 6] = ["Date", "Duration", "Attendees", "Company", "Type", "Prior context"];
pub const FIELDS_PLACEHOLDER: &str = "MCHEADERFIELDS";

pub struct HeaderField {
    pub name: String,
    pub value: Option<String>,
}

pub struct Header {
    pub fields: Vec<HeaderField>,
    pub missing: Vec<String>,
    pub body: String,
}

pub fn extract_header_fields(src: &str) -> Header {
    static END: LazyLock<regex::Regex> = LazyLock::new(|| js::re(r"^(##\s|---\s*$)", ""));
    static FIELD_LINE: LazyLock<regex::Regex> = LazyLock::new(|| js::re(r"^\*\*[^*]+:\*\*", ""));
    static SEG_SPLIT: LazyLock<fancy_regex::Regex> = LazyLock::new(|| js::fre(r"\s+\|\s+(?=\*\*[^*]+:\*\*)", ""));
    static SEG: LazyLock<regex::Regex> = LazyLock::new(|| js::re(r"^\*\*([^*]+):\*\*\s*(.*)$", ""));
    let lines = split_lines(src);
    let end = lines.iter().position(|l| END.is_match(l));
    let mut fields: Vec<(String, String)> = Vec::new();
    let mut placed = false;
    let mut body = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        if end.is_none_or(|e| i < e) && FIELD_LINE.is_match(line) {
            for seg in SEG_SPLIT.split(line) {
                let seg = seg.expect("split");
                if let Some(m) = SEG.captures(seg) {
                    fields.push((js::trim(&m[1]).to_string(), js::trim(&m[2]).to_string()));
                }
            }
            if !placed { body.push(FIELDS_PLACEHOLDER.to_string()); placed = true; }
            continue;
        }
        body.push(line.to_string());
    }
    let named: HashSet<&str> = fields.iter().map(|(n, _)| n.as_str()).collect();
    let missing = HEADER_FIELDS.iter().filter(|n| !named.contains(**n)).map(|n| n.to_string()).collect();
    let mut ordered: Vec<HeaderField> = HEADER_FIELDS.iter().map(|n| HeaderField {
        name: n.to_string(),
        value: fields.iter().find(|(f, _)| f == n).map(|(_, v)| v.clone()),
    }).collect();
    ordered.extend(fields.iter().filter(|(n, _)| !HEADER_FIELDS.contains(&n.as_str())).map(|(n, v)| HeaderField { name: n.clone(), value: Some(v.clone()) }));
    Header { fields: ordered, missing, body: body.join("\n") }
}

pub struct ActionItem {
    pub num: f64,
    pub text: String,
    pub owner: String,
    pub status: String,
}

pub struct OpenItem {
    pub from: String,
    pub text: String,
    pub owner: String,
    pub status: String,
}

pub struct Meeting {
    pub file: String,
    pub date: Option<String>,
    pub title: String,
    pub people: Option<Vec<String>>,
    pub kind: Option<String>,
    pub action_items: Vec<ActionItem>,
    pub open_items: Vec<OpenItem>,
    pub warnings: Vec<Warning>,
}

fn read_table(src: &str, heading: &str, required: &[&str], warn: &mut dyn FnMut(String)) -> Option<Vec<Row>> {
    let lines = section_lines(src, heading)?;
    let Some(table) = parse_table(&lines) else {
        warn(format!("\"{heading}\" table {COULD_NOT_READ}"));
        return Some(Vec::new());
    };
    let missing: Vec<&str> = required.iter().copied().filter(|h| !table.header.iter().any(|x| x == h)).collect();
    if !missing.is_empty() {
        warn(format!("\"{heading}\" table {COULD_NOT_READ}: missing column {}", missing.join(", ")));
        return Some(Vec::new());
    }
    for l in &table.bad { warn(format!("\"{heading}\" row {COULD_NOT_READ}: {}…", js::slice_to(l, 80))); }
    Some(table.rows)
}

pub fn parse_meeting(ws: &Workspace, file: &str) -> Result<Meeting, Error> {
    static FILE_DATE: LazyLock<regex::Regex> = LazyLock::new(|| js::re(r"^(\d{4}-\d{2}-\d{2})", ""));
    static YEAR: LazyLock<regex::Regex> = LazyLock::new(|| js::re(r"\d{4}", ""));
    static TITLE: LazyLock<regex::Regex> = LazyLock::new(|| js::re(r"^#\s+(.+)$", "m"));
    let src = ws.read_text(&format!("{MEETINGS_DIR}/{file}"))?;
    let mut warnings = Vec::new();
    let mut warn = |message: String| warnings.push(Warning { file: file.to_string(), message });

    let file_date = FILE_DATE.captures(file).map(|c| c[1].to_string());
    // A file name that starts with an impossible date (2026-02-30_...) has no date: the name and the
    // header can't both be right, so neither is used.
    let impossible_name = file_date.as_deref().is_some_and(|d| !js::is_real_date(d));
    let mut date = file_date.filter(|_| !impossible_name);
    if impossible_name {
        warn(format!("date {COULD_NOT_READ}: the file name starts with a date that doesn't exist"));
    } else if date.is_none() {
        let d = header_field(&src, "Date");
        date = d.filter(|d| YEAR.is_match(d)).and_then(|d| parse_dates(&d, "9999-12-31").into_iter().next());
        if date.is_none() { warn(format!("date {COULD_NOT_READ}")); }
    }
    let title = TITLE.captures(&src).map(|c| js::trim(&c[1]).to_string()).filter(|t| !t.is_empty());
    let attendees = header_field(&src, "Attendees").filter(|a| !a.is_empty());
    let kind = header_field(&src, "Type").filter(|t| !t.is_empty());
    if attendees.is_none() { warn(format!("attendees {COULD_NOT_READ}")); }
    if kind.is_none() { warn(format!("meeting type {COULD_NOT_READ}")); }

    let action_rows = read_table(&src, "Action Items", &["#", "Action Item", "Owner", "Status"], &mut warn);
    if action_rows.is_none() { warn("no \"Action Items\" section".to_string()); }
    let open_rows = read_table(&src, "Open Items from Earlier Meetings", &["From", "Item", "Owner", "Status now"], &mut warn).unwrap_or_default();

    let mut action_items = Vec::new();
    for r in action_rows.unwrap_or_default() {
        let raw = r.get("#").unwrap_or("");
        let num = js::string_to_number(&plain_text(raw));
        if !(num.is_finite() && num.fract() == 0.0 && num >= 1.0) {
            warn(format!("action item number {COULD_NOT_READ}: \"{raw}\""));
            continue;
        }
        action_items.push(ActionItem {
            num,
            text: r.get("Action Item").unwrap_or("").to_string(),
            owner: r.get("Owner").unwrap_or("").to_string(),
            status: r.get("Status").unwrap_or("").to_string(),
        });
    }
    let open_items = open_rows.iter().map(|r| OpenItem {
        from: r.get("From").unwrap_or("").to_string(),
        text: r.get("Item").unwrap_or("").to_string(),
        owner: r.get("Owner").unwrap_or("").to_string(),
        status: r.get("Status now").unwrap_or("").to_string(),
    }).collect();

    Ok(Meeting {
        file: file.to_string(),
        date,
        title: title.unwrap_or_else(|| COULD_NOT_READ.to_string()),
        people: attendees.map(|a| split_top_level(&a)),
        kind,
        action_items,
        open_items,
        warnings,
    })
}

/// The summaries' file names: the .md files in meeting-notes/, none if the folder is missing. These are the only
/// names a meeting is opened or linked by. A folder whose name ends in .md is not a summary (decision 77).
pub fn summary_files(ws: &Workspace) -> Result<Vec<String>, Error> {
    let mut files = Vec::new();
    for name in ws.list_dir(MEETINGS_DIR, ".md")?.unwrap_or_default() {
        if ws.resolve(&format!("{MEETINGS_DIR}/{name}"))?.is_file() { files.push(name); }
    }
    Ok(files)
}

/// Every summary, newest first; undated meetings go last.
pub fn load_meetings(ws: &Workspace) -> Result<Vec<Meeting>, Error> {
    let files = summary_files(ws)?;
    let mut meetings = files.iter().map(|f| parse_meeting(ws, f)).collect::<Result<Vec<_>, _>>()?;
    meetings.sort_by(|a, b| {
        js::locale_compare(b.date.as_deref().unwrap_or(""), a.date.as_deref().unwrap_or(""), false)
            .then_with(|| js::locale_compare(&a.file, &b.file, false))
    });
    Ok(meetings)
}

// ---------- text matching ----------

const STOP: &str = "a an and are as at be but by e.g eg for from if in into is it its not of off on or per so than that the then their them they this to up vs with he she him his her suggested said meeting";

fn tokens(text: &str) -> HashSet<String> {
    static QUOTES: LazyLock<regex::Regex> = LazyLock::new(|| js::re("[’‘]", ""));
    static POSSESSIVE: LazyLock<regex::Regex> = LazyLock::new(|| js::re(r"'s\b", ""));
    static SPLIT: LazyLock<regex::Regex> = LazyLock::new(|| js::re(r"[^a-z0-9']+", ""));
    static EDGE_QUOTES: LazyLock<regex::Regex> = LazyLock::new(|| js::re(r"^'+|'+$", ""));
    static DAY: LazyLock<regex::Regex> = LazyLock::new(|| js::re(r"^\d{1,2}$", ""));
    let stop: HashSet<&str> = STOP.split(' ').collect();
    let lower = plain_text(text).to_lowercase();
    let s = QUOTES.replace_all(&lower, "'");
    let s = POSSESSIVE.replace_all(&s, "");
    SPLIT.split(&s)
        .map(|t| EDGE_QUOTES.replace_all(t, "").into_owned())
        // Dates differ between mentions of the same item, so month names and day numbers don't count.
        .filter(|t| js::len(t) > 1 && !stop.contains(t.as_str()) && month_number(t).is_none() && !DAY.is_match(t))
        .map(|t| stem(&t))
        .collect()
}

fn stem(t: &str) -> String {
    static SUFFIX: LazyLock<regex::Regex> = LazyLock::new(|| js::re("(ing|ed|es|s)$", ""));
    if js::len(t) <= 4 { return t.to_string(); }
    SUFFIX.replace(t, "").into_owned()
}

/// Share of the shorter text's words that also appear in the longer one.
fn similarity(a: &HashSet<String>, b: &HashSet<String>) -> (f64, usize) {
    let shared = a.iter().filter(|t| b.contains(*t)).count();
    (shared as f64 / (a.len().min(b.len()).max(1)) as f64, shared)
}

const MATCH_SCORE: f64 = 0.75;
const MIN_SHARED: usize = 3;
const MIN_MARGIN: f64 = 0.15;

pub fn is_suggested(text: &str, status: &str) -> bool {
    static IN_TEXT: LazyLock<regex::Regex> = LazyLock::new(|| js::re(r"\(suggested", "i"));
    static IN_STATUS: LazyLock<regex::Regex> = LazyLock::new(|| js::re(r"^suggested\b", "i"));
    IN_TEXT.is_match(text) || IN_STATUS.is_match(&plain_text(status))
}

// ---------- roll-up ----------

struct Mention {
    file: String,
    date: String,
    owner: String,
    status: String,
    kind: &'static str,
}

struct Tracked {
    key: String,
    text: String,
    first_seen: Option<String>,
    first_seen_text: Option<String>,
    suggested: bool,
    unmatched: bool,
    tokens: HashSet<String>,
    mentions: Vec<Mention>,
}

/// Every action item starts a tracked item (key: meeting file + item number). Each later "Open Items
/// from Earlier Meetings" row is attached to an item from the meeting it came from only when the text
/// matches closely and no other candidate comes near. Anything else becomes its own row, tagged "unmatched".
pub fn build_tracked(meetings: &[Meeting], as_of: &str) -> (Vec<Value>, Vec<Warning>) {
    let mut chrono: Vec<&Meeting> = meetings.iter().filter(|m| m.date.is_some()).collect();
    chrono.sort_by(|a, b| js::locale_compare(a.date.as_deref().unwrap(), b.date.as_deref().unwrap(), false).then_with(|| js::locale_compare(&a.file, &b.file, false)));
    let mut items: Vec<Tracked> = Vec::new();
    let mut warnings = Vec::new();

    for m in chrono {
        let date = m.date.clone().unwrap();
        let mention = |owner: &str, status: &str, kind| Mention { file: m.file.clone(), date: date.clone(), owner: owner.to_string(), status: status.to_string(), kind };
        for a in &m.action_items {
            items.push(Tracked {
                key: format!("{}#{}", m.file, js::number_to_string(a.num)),
                text: a.text.clone(),
                first_seen: Some(date.clone()),
                first_seen_text: None,
                suggested: is_suggested(&a.text, &a.status),
                unmatched: false,
                tokens: tokens(&a.text),
                mentions: vec![mention(&a.owner, &a.status, "action item")],
            });
        }

        for (oi, o) in m.open_items.iter().enumerate() {
            let origin = parse_dates(&plain_text(&o.from), &date).into_iter().next();
            let t = tokens(&o.text);
            let mut target = None;
            if let Some(origin) = &origin {
                let mut candidates: Vec<(usize, f64, usize)> = items.iter().enumerate()
                    .filter(|(_, it)| it.first_seen.as_ref() == Some(origin) && !it.mentions.iter().any(|x| x.file == m.file && x.kind == "earlier item"))
                    .map(|(i, it)| { let (score, shared) = similarity(&t, &it.tokens); (i, score, shared) })
                    .collect();
                candidates.sort_by(|x, y| y.1.partial_cmp(&x.1).unwrap_or(Ordering::Equal));
                if let Some(best) = candidates.first() {
                    let second = candidates.get(1);
                    if best.1 >= MATCH_SCORE && best.2 >= MIN_SHARED && second.is_none_or(|s| best.1 - s.1 >= MIN_MARGIN) {
                        target = Some(best.0);
                    }
                }
            }
            match target {
                Some(i) => items[i].mentions.push(mention(&o.owner, &o.status, "earlier item")),
                None => {
                    if origin.is_none() {
                        warnings.push(Warning { file: m.file.clone(), message: format!("first-seen date {COULD_NOT_READ}: \"{}\"", plain_text(&o.from)) });
                    }
                    items.push(Tracked {
                        key: format!("{}#open-{}", m.file, oi + 1),
                        text: o.text.clone(),
                        first_seen_text: if origin.is_some() { None } else { Some(plain_text(&o.from)) },
                        first_seen: origin,
                        suggested: is_suggested(&o.text, ""),
                        unmatched: true,
                        tokens: t,
                        mentions: vec![mention(&o.owner, &o.status, "earlier item")],
                    });
                }
            }
        }
    }

    static CLOSED: LazyLock<regex::Regex> = LazyLock::new(|| js::re(r"^(closed|done)\b", "i"));
    let mut rows: Vec<(Option<String>, String, Value)> = items.iter().map(|it| {
        let latest = it.mentions.last().unwrap();
        let latest_status = plain_text(&latest.status);
        let row = json!({
            "key": it.key,
            "text": plain_text(&it.text),
            "textHtml": render_inline(&it.text),
            "owner": plain_text(&latest.owner),
            "firstSeen": it.first_seen,
            "firstSeenText": it.first_seen_text,
            "ageDays": it.first_seen.as_deref().and_then(|f| days_between(f, as_of)),
            "latestStatus": latest_status,
            "latestStatusHtml": render_inline(&latest.status),
            "closed": CLOSED.is_match(&latest_status),
            "suggested": it.suggested,
            "unmatched": it.unmatched,
            "owners": owner_names(&latest.owner),
            "sources": it.mentions.iter().map(|x| json!({ "file": x.file, "date": x.date, "kind": x.kind })).collect::<Vec<_>>(),
        });
        (it.first_seen.clone(), it.key.clone(), row)
    }).collect();
    // Oldest first; rows whose first-seen date could not be read go last.
    rows.sort_by(|a, b| {
        js::locale_compare(a.0.as_deref().unwrap_or("9999"), b.0.as_deref().unwrap_or("9999"), false)
            .then_with(|| js::locale_compare(&a.1, &b.1, true))
    });
    (rows.into_iter().map(|r| r.2).collect(), warnings)
}

pub fn meetings_overview(ws: &Workspace, demo: bool) -> Result<Value, Error> {
    let meetings = load_meetings(ws)?;
    let newest = meetings.iter().find_map(|m| m.date.clone());
    let as_of = match (&newest, demo) { (Some(n), true) => n.clone(), _ => today_iso() };
    let (tracked, tracked_warnings) = build_tracked(&meetings, &as_of);
    let mut owners: Vec<String> = Vec::new();
    for r in &tracked {
        for o in r["owners"].as_array().unwrap() {
            let o = o.as_str().unwrap().to_string();
            if !owners.contains(&o) { owners.push(o); }
        }
    }
    owners.sort_by(|a, b| js::cmp_utf16(a, b));
    let warnings: Vec<Warning> = meetings.iter().flat_map(|m| m.warnings.clone()).chain(tracked_warnings).collect();
    Ok(json!({
        "asOf": as_of,
        "asOfIsNewestMeeting": demo && newest.is_some(),
        "meetings": meetings.iter().map(|m| json!({ "file": m.file, "date": m.date, "title": m.title, "people": m.people, "type": m.kind })).collect::<Vec<_>>(),
        "tracked": tracked,
        "owners": owners,
        "warnings": warnings,
    }))
}
