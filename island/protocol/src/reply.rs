//! Turning the island's answer into what Claude Code reads from a hook's stdout.
//! Format: https://code.claude.com/docs/en/hooks (PermissionRequest decision control).
//!
//! Anything not understood prints nothing: silence means "no decision", and
//! Claude Code then asks in its terminal (or, under `claude -p`, denies).

use serde_json::{json, Map, Value};

use crate::wire::Reply;
use crate::APP_NAME;

/// The JSON line to print for `event`, or `None` to print nothing.
/// `payload` is the hook input as Claude Code sent it.
pub fn claude_output(event: &str, reply: Option<&Reply>, payload: &Value) -> Option<String> {
    if event != "PermissionRequest" {
        return None;
    }
    let reply = reply?;
    let decision = match reply.decision.as_deref()?.trim() {
        "allow" => allow_with(payload, reply)?,
        "always" => {
            let suggestions = payload.get("permission_suggestions").and_then(Value::as_array).filter(|l| !l.is_empty());
            match suggestions {
                Some(list) => json!({ "behavior": "allow", "updatedPermissions": list }),
                None => json!({ "behavior": "allow" }),
            }
        }
        "deny" => {
            let message = reply
                .feedback
                .as_deref()
                .map(str::trim)
                .filter(|f| !f.is_empty())
                .map(|f| format!("Denied from {APP_NAME}: {f}"))
                .unwrap_or_else(|| format!("Denied from {APP_NAME}"));
            json!({ "behavior": "deny", "message": message })
        }
        _ => return None,
    };
    Some(json!({ "hookSpecificOutput": { "hookEventName": "PermissionRequest", "decision": decision } }).to_string())
}

/// A plain allow, or — for an answered AskUserQuestion — an allow whose input
/// carries the answers. Answers that do not match the question are refused (None).
fn allow_with(payload: &Value, reply: &Reply) -> Option<Value> {
    let Some(answers) = reply.answers.as_ref() else {
        return Some(json!({ "behavior": "allow" }));
    };
    if payload.get("tool_name").and_then(Value::as_str) != Some("AskUserQuestion") {
        return None;
    }
    let input = payload.get("tool_input")?.as_object()?;
    if !answers_fit(input, answers) {
        return None;
    }
    let mut updated = input.clone();
    updated.insert("answers".into(), Value::Object(answers.clone()));
    Some(json!({ "behavior": "allow", "updatedInput": updated }))
}

/// Every answer names an asked question and only offered labels (a multi-select
/// answer joins labels with ", ").
fn answers_fit(input: &Map<String, Value>, answers: &Map<String, Value>) -> bool {
    let Some(questions) = input.get("questions").and_then(Value::as_array) else {
        return false;
    };
    if answers.is_empty() {
        return false;
    }
    answers.iter().all(|(text, answer)| {
        let Some(q) = questions.iter().find(|q| q.get("question").and_then(Value::as_str) == Some(text)) else {
            return false;
        };
        let Some(answer) = answer.as_str() else { return false };
        let labels: Vec<&str> = q
            .get("options")
            .and_then(Value::as_array)
            .map(|o| o.iter().filter_map(|o| o.get("label").and_then(Value::as_str)).collect())
            .unwrap_or_default();
        let multi = q.get("multiSelect").and_then(Value::as_bool).unwrap_or(false);
        if multi {
            !answer.is_empty() && answer.split(", ").all(|a| labels.contains(&a))
        } else {
            labels.contains(&answer)
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reply(decision: &str) -> Reply {
        Reply { decision: Some(decision.into()), ..Reply::default() }
    }

    fn bash() -> Value {
        json!({ "hook_event_name": "PermissionRequest", "tool_name": "Bash", "tool_input": { "command": "npm run build" } })
    }

    #[test]
    fn allow_and_deny_match_the_documented_shape() {
        assert_eq!(
            claude_output("PermissionRequest", Some(&reply("allow")), &bash()).unwrap(),
            r#"{"hookSpecificOutput":{"decision":{"behavior":"allow"},"hookEventName":"PermissionRequest"}}"#
        );
        let deny: Value = serde_json::from_str(&claude_output("PermissionRequest", Some(&reply("deny")), &bash()).unwrap()).unwrap();
        assert_eq!(deny["hookSpecificOutput"]["decision"]["behavior"], "deny");
        assert_eq!(deny["hookSpecificOutput"]["decision"]["message"], "Denied from Jarvis Island");
    }

    #[test]
    fn deny_carries_feedback() {
        let r = Reply { decision: Some("deny".into()), feedback: Some(" use pnpm ".into()), ..Reply::default() };
        let v: Value = serde_json::from_str(&claude_output("PermissionRequest", Some(&r), &bash()).unwrap()).unwrap();
        assert_eq!(v["hookSpecificOutput"]["decision"]["message"], "Denied from Jarvis Island: use pnpm");
    }

    #[test]
    fn always_echoes_suggestions() {
        let mut p = bash();
        p["permission_suggestions"] = json!([{ "type": "addRules", "rules": [{ "toolName": "Bash", "ruleContent": "npm run build" }], "behavior": "allow", "destination": "localSettings" }]);
        let v: Value = serde_json::from_str(&claude_output("PermissionRequest", Some(&reply("always")), &p).unwrap()).unwrap();
        assert_eq!(v["hookSpecificOutput"]["decision"]["updatedPermissions"][0]["type"], "addRules");
        // Without suggestions, "always" is a plain allow.
        let v: Value = serde_json::from_str(&claude_output("PermissionRequest", Some(&reply("always")), &bash()).unwrap()).unwrap();
        assert!(v["hookSpecificOutput"]["decision"].get("updatedPermissions").is_none());
    }

    #[test]
    fn silence_for_other_events_and_unknown_or_missing_decisions() {
        assert!(claude_output("PreToolUse", Some(&reply("allow")), &bash()).is_none());
        assert!(claude_output("PermissionRequest", None, &bash()).is_none());
        assert!(claude_output("PermissionRequest", Some(&Reply::none()), &bash()).is_none());
        assert!(claude_output("PermissionRequest", Some(&reply("maybe")), &bash()).is_none());
    }

    fn question() -> Value {
        json!({
            "tool_name": "AskUserQuestion",
            "tool_input": { "questions": [
                { "question": "Which DB?", "header": "DB", "multiSelect": false, "options": [{ "label": "Postgres" }, { "label": "SQLite" }] },
                { "question": "Extras?", "header": "Extras", "multiSelect": true, "options": [{ "label": "Auth" }, { "label": "Tests" }] }
            ]}
        })
    }

    #[test]
    fn answers_become_updated_input() {
        let mut answers = Map::new();
        answers.insert("Which DB?".into(), json!("SQLite"));
        answers.insert("Extras?".into(), json!("Auth, Tests"));
        let r = Reply { decision: Some("allow".into()), answers: Some(answers), feedback: None };
        let v: Value = serde_json::from_str(&claude_output("PermissionRequest", Some(&r), &question()).unwrap()).unwrap();
        let input = &v["hookSpecificOutput"]["decision"]["updatedInput"];
        assert_eq!(input["answers"]["Which DB?"], "SQLite");
        assert_eq!(input["questions"][0]["header"], "DB");
    }

    #[test]
    fn answers_that_do_not_fit_print_nothing() {
        for (q, a) in [("Which DB?", "Mongo"), ("Unasked?", "Postgres"), ("Extras?", "")] {
            let mut answers = Map::new();
            answers.insert(q.into(), json!(a));
            let r = Reply { decision: Some("allow".into()), answers: Some(answers), feedback: None };
            assert!(claude_output("PermissionRequest", Some(&r), &question()).is_none(), "{q}={a}");
        }
        // Answers on a tool other than AskUserQuestion are refused too.
        let mut answers = Map::new();
        answers.insert("Which DB?".into(), json!("SQLite"));
        let r = Reply { decision: Some("allow".into()), answers: Some(answers), feedback: None };
        assert!(claude_output("PermissionRequest", Some(&r), &bash()).is_none());
    }
}
