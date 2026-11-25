use super::*;
use RedactCategory::*;

fn spans(text: &str) -> Vec<(RedactCategory, String)> {
    classify_line(text)
        .into_iter()
        .map(|f| {
            (
                f.category,
                text.chars().skip(f.start).take(f.end - f.start).collect(),
            )
        })
        .collect()
}

fn has(text: &str, category: RedactCategory, value: &str) {
    let found = spans(text);
    assert!(
        found.iter().any(|(c, v)| *c == category && v == value),
        "{text:?}: expected {category:?} {value:?}, got {found:?}"
    );
}

fn none_of(text: &str, category: RedactCategory) {
    let found = spans(text);
    assert!(
        !found.iter().any(|(c, _)| *c == category),
        "{text:?}: unexpected {category:?} in {found:?}"
    );
}

#[test]
fn emails_inside_sentences() {
    has(
        "Send it to jane.doe+cap@example.org today",
        Email,
        "jane.doe+cap@example.org",
    );
    has(
        "From: Bob <bob_smith@mail.example.com>",
        Email,
        "bob_smith@mail.example.com",
    );
    has("contact jane @ example.com", Email, "jane @ example.com");
    has("typing jane.doe@exam", Email, "jane.doe@exam");
}

#[test]
fn email_lookalikes() {
    none_of("@Override public void run()", Email);
    none_of("follow @exampleapp for updates", Email);
    none_of("npm i @types/node", Email);
}

#[test]
fn cards_pass_luhn_only() {
    has(
        "Card 4242 4242 4242 4242 exp 12/30",
        Card,
        "4242 4242 4242 4242",
    );
    has("amex 3782-822463-10005", Card, "3782-822463-10005");
    has("4111111111111111", Card, "4111111111111111");
    has("card 40O0 0566 5566 5556", Card, "40O0 0566 5566 5556");
    none_of("order 4242 4242 4242 4241", Card);
    none_of("0000 0000 0000 0000", Card);
    none_of("•••• •••• •••• 4242", Card);
}

#[test]
fn ibans_and_bank_numbers() {
    has(
        "IBAN: GB82 WEST 1234 5698 7654 32",
        Card,
        "IBAN: GB82 WEST 1234 5698 7654 32",
    );
    has("DE89370400440532013000", Card, "DE89370400440532013000");
    has(
        "Account number 12345678 sort code 12-34-56",
        Card,
        "Account number 12345678",
    );
    has(
        "Account number 12345678 sort code 12-34-56",
        Card,
        "sort code 12-34-56",
    );
    has("Routing 021000021", Card, "Routing 021000021");
    has("pay by card using ABA075617479", Card, "ABA075617479");
    none_of("GB82 WEST 1234 5698 7654 33", Card);
}

#[test]
fn phones_in_common_formats() {
    has("Call (415) 555-0132 now", Phone, "(415) 555-0132");
    has("415.555.0132", Phone, "415.555.0132");
    has("+44 20 7946 0958", Phone, "+44 20 7946 0958");
    has("+1-202-555-0175", Phone, "+1-202-555-0175");
    has("Mobile: 07700 900123", Phone, "07700 900123");
    has("Tel: 030 1234567", Phone, "030 1234567");
    has("phone 5551234567", Phone, "5551234567");
}

#[test]
fn numbers_that_are_not_phones() {
    none_of("2024-03-15 10:42:00", Phone);
    none_of("12/05/2023", Phone);
    none_of("version 1.24.3 build 20231115", Phone);
    none_of("Total: $1,234,567.89", Phone);
    none_of("192.168.1.10", Phone);
    none_of("commit 3f9a2b1 on 2024-01-02", Phone);
    none_of("1920 x 1080 at 60 fps", Phone);
    none_of("Order #12345678", Phone);
    none_of("ISBN 978-3-16-148410-0", Phone);
    none_of("page 123 of 4567", Phone);
}

#[test]
fn known_secret_prefixes() {
    has(
        "STRIPE_SECRET_KEY=sk_live_51HxAbCdEfGhIjKlMn",
        Secret,
        "sk_live_51HxAbCdEfGhIjKlMn",
    );
    has(
        "token ghp_0123456789abcdefABCDEF0123456789abcd",
        Secret,
        "ghp_0123456789abcdefABCDEF0123456789abcd",
    );
    has("aws AKIAIOSFODNN7EXAMPLE", Secret, "AKIAIOSFODNN7EXAMPLE");
    has(
        "OPENAI_API_KEY=sk-proj-abcDEF123456ghiJKL789",
        Secret,
        "sk-proj-abcDEF123456ghiJKL789",
    );
    has(
        "xoxb-123456789012-abcdefghijkl",
        Secret,
        "xoxb-123456789012-abcdefghijkl",
    );
    has(
        "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
        Secret,
        "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    );
    has(
        "-----BEGIN RSA PRIVATE KEY-----",
        Secret,
        "-----BEGIN RSA PRIVATE KEY-----",
    );
}

#[test]
fn assigned_passwords_and_tokens() {
    has("password: hunter2!", Secret, "hunter2!");
    has("DB_PASSWORD=Tr0ub4dor&3", Secret, "Tr0ub4dor&3");
    has("\"api_key\": \"9f8e7d6c5b4a\"", Secret, "9f8e7d6c5b4a");
    has(
        "Authorization: Bearer abcdef1234567890ABCDEF",
        Secret,
        "abcdef1234567890ABCDEF",
    );
    has(
        "postgres://admin:s3cr3tpass@db.example.com:5432/app",
        Secret,
        "s3cr3tpass",
    );
}

#[test]
fn secret_lookalikes() {
    none_of("password: ********", Secret);
    none_of("const password = process.env.DB_PASSWORD;", Secret);
    none_of("type=\"password\"", Secret);
    none_of("token: string;", Secret);
    none_of("passwordLength = 12", Secret);
    none_of(
        "git checkout 3f9a2b1c4d5e6f708192a3b4c5d6e7f8091a2b3c",
        Secret,
    );
    none_of("id 123e4567-e89b-12d3-a456-426614174000", Secret);
    none_of("getUserProfileSettingsForAccount", Secret);
    none_of("src/components/settings/AccountPanel.tsx", Secret);
    none_of("com.example.application.services", Secret);
    none_of("API_KEY=${API_KEY}", Secret);
}

#[test]
fn high_entropy_tokens() {
    has(
        "key Zx9Qp2Lm7Rt4Vb8Nc3Kd6Hf1",
        Secret,
        "Zx9Qp2Lm7Rt4Vb8Nc3Kd6Hf1",
    );
}

#[test]
fn ip_addresses() {
    has("ssh root@203.0.113.42", Ip, "203.0.113.42");
    has("server 10.0.0.12:8080 up", Ip, "10.0.0.12:8080");
    has(
        "addr 2001:db8:85a3::8a2e:370:7334",
        Ip,
        "2001:db8:85a3::8a2e:370:7334",
    );
    none_of("version 1.2.3.4", Ip);
    none_of("v1.2.3.4", Ip);
    none_of("localhost 127.0.0.1", Ip);
    none_of("at 12:30:45 today", Ip);
}

#[test]
fn links() {
    has(
        "see https://dashboard.example.com/acct/123?x=1.",
        Url,
        "https://dashboard.example.com/acct/123?x=1",
    );
    has("www.example.org/path", Url, "www.example.org/path");
    has("go to example.com/pricing", Url, "example.com/pricing");
    none_of("open main.rs and lib.rs", Url);
    none_of("config.json", Url);
}

#[test]
fn addresses() {
    has("Ship to 1742 Maple Avenue NW", Address, "1742 Maple Avenue");
    has("Springfield, IL 62704", Address, "Springfield, IL 62704");
    has("London SW1A 1AA", Address, "SW1A 1AA");
    none_of("Updated 3 Files Today", Address);
}

#[test]
fn secret_inside_url_keeps_both() {
    let text = "https://api.example.com/v1?key=AIzaSyA1234567890abcdefghijklmnopqrstu";
    let found = spans(text);
    assert!(
        found
            .iter()
            .any(|(c, v)| *c == Secret && v.starts_with("AIza")),
        "{found:?}"
    );
    assert!(
        found.iter().any(|(c, v)| *c == Url && v == text),
        "{found:?}"
    );
}

#[test]
fn label_on_the_line_above() {
    let lines = [
        LineContext {
            text: "Password",
            x: 0.1,
            y: 0.1,
            w: 0.08,
            h: 0.02,
        },
        LineContext {
            text: "correct horse",
            x: 0.1,
            y: 0.13,
            w: 0.15,
            h: 0.02,
        },
        LineContext {
            text: "Forgot password?",
            x: 0.1,
            y: 0.30,
            w: 0.15,
            h: 0.02,
        },
    ];
    let results = classify_frame(&lines);
    let beside = classify_frame(&[
        LineContext {
            text: "Restricted key",
            x: 0.48,
            y: 0.50,
            w: 0.057,
            h: 0.02,
        },
        LineContext {
            text: "Falcon#740Q",
            x: 0.58,
            y: 0.50,
            w: 0.057,
            h: 0.019,
        },
    ]);
    assert_eq!(beside[1].len(), 1);
    assert!(results[1].is_empty(), "{results:?}");
    assert!(results[2].is_empty());
}

#[test]
fn split_tokens_are_glued_back() {
    has(
        "export GITHUB_T0KEN=ghp_x7Kq2LmN9pR4sT6vW8yZ0bC3dF5gH1j K21Mn",
        Secret,
        "ghp_x7Kq2LmN9pR4sT6vW8yZ0bC3dF5gH1j K21Mn",
    );
    has(
        "mail jane.doe@examp le.com now",
        Email,
        "jane.doe@examp le.com",
    );
    has(
        "STRIPE_SECRET_KEY=sk_1ive_51HxQp L2eZvKY1o2C8nT0aB7d",
        Secret,
        "sk_1ive_51HxQp L2eZvKY1o2C8nT0aB7d",
    );
    none_of("call me now please", Secret);
}

#[test]
fn wrapped_strings_are_found_on_both_lines() {
    let line = |text, y| LineContext {
        text,
        x: 0.1,
        y,
        w: 0.2,
        h: 0.02,
    };
    let lines = [
        line("Call our billing team on +1 (436)", 0.10),
        line("519-9838 any weekday.", 0.125),
        line("Ship to 4013 Pine Court, Suite", 0.30),
        line("754, Columbus, OH 26159", 0.325),
    ];
    let results = classify_frame(&lines);
    let text = |index: usize, category: RedactCategory| {
        results[index]
            .iter()
            .filter(|f| f.category == category)
            .map(|f| {
                lines[index]
                    .text
                    .chars()
                    .skip(f.start)
                    .take(f.end - f.start)
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
    };
    assert_eq!(text(0, Phone), vec!["+1 (436)"]);
    assert_eq!(text(1, Phone), vec!["519-9838"]);
    assert!(!text(2, Address).is_empty());
    assert!(!text(3, Address).is_empty());
}

#[test]
fn unicode_offsets_are_chars() {
    let text = "Ünïcödé jane@example.com";
    let found = classify_line(text);
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].start, 8);
    assert_eq!(found[0].end, text.chars().count());
}

fn alternatives_for(
    text: &str,
    swaps: &[(usize, char, f32)],
    blanks: &[(usize, f32)],
) -> Vec<crate::model::Alternatives> {
    let mut alternatives = vec![crate::model::Alternatives::default(); text.chars().count()];
    for (index, ch, p) in swaps {
        alternatives[*index].options.push((*ch, *p));
    }
    for (index, p) in blanks {
        alternatives[*index].blank = *p;
    }
    alternatives
}

#[test]
fn a_card_with_a_misread_digit_is_found_through_the_runner_up() {
    let text = "\u{f3}011-7783-7998-9143";
    assert!(classify_line(text).iter().all(|f| f.category != Card));
    let alternatives = alternatives_for(text, &[(0, '6', 0.3)], &[]);
    let found = classify_line_with_alternatives(text, &alternatives);
    assert!(
        found
            .iter()
            .any(|f| f.category == Card && f.start == 0 && f.end == 19),
        "{found:?}"
    );
}

#[test]
fn runner_ups_that_fail_the_checksum_add_nothing() {
    let text = "\u{f3}011-7783-7998-9144";
    let alternatives = alternatives_for(text, &[(0, '6', 0.3)], &[]);
    assert!(
        classify_line_with_alternatives(text, &alternatives)
            .iter()
            .all(|f| f.category != Card)
    );
}

#[test]
fn a_nearly_skipped_space_does_not_hide_an_address() {
    let text = "from 203.0.113. 144 port 22";
    let alternatives = alternatives_for(text, &[], &[(15, 0.4)]);
    let found = classify_line_with_alternatives(text, &alternatives);
    assert!(
        found.iter().any(|f| f.category == Ip && f.start == 5),
        "{found:?}"
    );
}

#[test]
fn an_at_sign_read_as_something_else_is_found() {
    let text = "mail jesse.kim\u{a9}acme.io now";
    let alternatives = alternatives_for(text, &[(14, '@', 0.2)], &[]);
    let found = classify_line_with_alternatives(text, &alternatives);
    assert!(
        found
            .iter()
            .any(|f| f.category == Email && f.start == 5 && f.end == 22),
        "{found:?}"
    );
}

#[test]
fn a_phone_wrapped_after_its_hyphen_is_found_on_both_lines() {
    let lines = [
        LineContext {
            text: "unclear, call me on (631) 555-",
            x: 0.81,
            y: 0.771,
            w: 0.145,
            h: 0.028,
        },
        LineContext {
            text: "0153",
            x: 0.815,
            y: 0.803,
            w: 0.026,
            h: 0.021,
        },
    ];
    let found = classify_frame(&lines);
    assert!(
        found[0]
            .iter()
            .any(|f| f.category == Phone && f.start == 20),
        "{found:?}"
    );
    assert!(
        found[1]
            .iter()
            .any(|f| f.category == Phone && f.start == 0 && f.end == 4),
        "{found:?}"
    );
}

#[test]
fn an_address_cut_off_at_the_end_of_a_line_is_hidden() {
    let found = classify_line("VPN 198.51.100.");
    assert!(
        found
            .iter()
            .any(|f| f.category == Ip && f.start == 4 && f.end == 15),
        "{found:?}"
    );
    assert!(
        classify_line("see section 1.2.3. for details")
            .iter()
            .all(|f| f.category != Ip)
    );
}

#[test]
fn names_come_from_mail_structure() {
    let spans = |text: &str| {
        classify_line(text)
            .into_iter()
            .filter(|f| f.category == Name)
            .map(|f| {
                text.chars()
                    .skip(f.start)
                    .take(f.end - f.start)
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
    };
    assert!(spans("From: Jane Roe <juno+test@example.org>").contains(&"Jane Roe".to_string()));
    assert!(spans("Hi Juno,").contains(&"Juno".to_string()));
    let at = |text, x: f32, y: f32| LineContext {
        text,
        x,
        y,
        w: 0.06,
        h: 0.02,
    };
    let lines = [
        at("Best", 0.33, 0.42),
        at("Jane Roe", 0.33, 0.44),
        at("Rosa Testa", 0.13, 0.37),
        at("8:59 PM", 0.28, 0.374),
        at("Quick question", 0.13, 0.16),
        at("4:33 PM", 0.28, 0.16),
    ];
    let found = classify_frame(&lines);
    assert!(found[1].iter().any(|f| f.category == Name), "{found:?}");
    assert!(found[2].iter().any(|f| f.category == Name), "{found:?}");
    assert!(found[4].iter().all(|f| f.category != Name), "{found:?}");
}

#[test]
fn an_unspaced_iban_with_a_letter_digits_look_like_is_found() {
    let found = classify_line("ES4266405477316390573152");
    assert!(
        found
            .iter()
            .any(|f| f.category == Card && f.start == 0 && f.end == 24),
        "{found:?}"
    );
}

#[test]
fn findings_cover_whole_words_and_whole_names() {
    let text = "Rosa Testa replied to jane.doe@exam";
    let found = widen(
        text,
        vec![
            Finding {
                category: Name,
                start: 5,
                end: 10,
            },
            Finding {
                category: Email,
                start: 23,
                end: 31,
            },
        ],
    );
    assert!(
        found.contains(&Finding {
            category: Name,
            start: 0,
            end: 10
        }),
        "{found:?}"
    );
    assert!(
        found.contains(&Finding {
            category: Email,
            start: 22,
            end: 35
        }),
        "{found:?}"
    );
    let greeting = widen(
        "Hi Juno,",
        vec![Finding {
            category: Name,
            start: 3,
            end: 7,
        }],
    );
    assert_eq!(
        greeting,
        vec![Finding {
            category: Name,
            start: 3,
            end: 7
        }]
    );
}

#[test]
fn three_octets_in_an_ip_column_are_a_cut_address() {
    let line = |text, y| LineContext {
        text,
        x: 0.52,
        y,
        w: 0.047,
        h: 0.022,
    };
    let lines = [
        line("IP", 0.17),
        line("198.51.100.7", 0.28),
        line("198.51.100", 0.36),
        line("10.125.58.7", 0.44),
        LineContext {
            text: "1.2.3",
            x: 0.1,
            y: 0.36,
            w: 0.02,
            h: 0.022,
        },
    ];
    let own = lines.iter().map(|l| classify_line(l.text)).collect();
    let found = classify_frame_with(&lines, own);
    assert!(
        found[2]
            .iter()
            .any(|f| f.category == Ip && f.start == 0 && f.end == 10),
        "{found:?}"
    );
    assert!(found[4].iter().all(|f| f.category != Ip), "{found:?}");
    let alone = [line("198.51.100", 0.36)];
    let own = alone.iter().map(|l| classify_line(l.text)).collect();
    assert!(classify_frame_with(&alone, own)[0].is_empty());
}

#[test]
fn numbers_and_keys_cut_by_the_frame_edge_are_found() {
    let at = |text, x, w| LineContext {
        text,
        x,
        y: 0.5,
        w,
        h: 0.02,
    };
    let lines = [
        at("Card 4242 4242 42", 0.8, 0.2),
        at("8291 0045 is the account", 0.0, 0.3),
        at("token sk_live_51Hq7x2AbCdEf9", 0.7, 0.3),
        at("Account DE89 3704 0044", 0.75, 0.25),
        at("Released in version 2024", 0.75, 0.25),
    ];
    let own = lines.iter().map(|l| classify_line(l.text)).collect();
    let found = classify_frame_with(&lines, own);
    let has = |i: usize, c: RedactCategory| found[i].iter().any(|f| f.category == c);
    assert!(has(0, Card), "{found:?}");
    assert!(has(1, Card), "{found:?}");
    assert!(has(2, Secret), "{found:?}");
    assert!(has(3, Card), "{found:?}");
    assert!(found[4].is_empty(), "{found:?}");
    let dates = [
        at("Due 2026-11-24", 0.8, 0.2),
        at("2026-11-24 to 2026-12-01", 0.0, 0.3),
        at("Updated 2026-11-14 15", 0.8, 0.2),
    ];
    let own = dates.iter().map(|l| classify_line(l.text)).collect();
    let found = classify_frame_with(&dates, own);
    assert!(
        found.iter().flatten().all(|f| f.category != Card),
        "{found:?}"
    );
    let phone = [at("Tel 06-12-34-56", 0.8, 0.2)];
    let own = phone.iter().map(|l| classify_line(l.text)).collect();
    let found = classify_frame_with(&phone, own);
    assert!(!found[0].is_empty(), "{found:?}");
    let inside = [at("Card 4242 4242 42", 0.5, 0.2)];
    let own = vec![classify_line(inside[0].text)];
    assert_eq!(
        classify_frame_with(&inside, own),
        vec![classify_line(inside[0].text)]
    );
}

#[test]
fn timestamps_next_to_phone_or_account_words_are_not_numbers() {
    for text in [
        "Account 2026-11-14 15:37:28",
        "Acct 2026-09-28",
        "2026-11-20 17:39:51 phone",
        "Phone: 2026-11-20 17:39:51",
    ] {
        let found = classify_line(text);
        assert!(
            found
                .iter()
                .all(|f| f.category != Card && f.category != Phone),
            "{text}: {found:?}"
        );
    }
    let found = classify_line("2026-11-20 17:39:51 acct 99351227");
    assert_eq!(
        found
            .iter()
            .filter(|f| f.category == Card)
            .map(|f| f.start)
            .collect::<Vec<_>>(),
        vec![20],
        "{found:?}"
    );
    let column = [
        LineContext {
            text: "2026-11-19 11:06:00",
            x: 0.38,
            y: 0.47,
            w: 0.11,
            h: 0.015,
        },
        LineContext {
            text: "2026-11-14 15:21:40",
            x: 0.38,
            y: 0.49,
            w: 0.11,
            h: 0.015,
        },
    ];
    let own = column.iter().map(|l| classify_line(l.text)).collect();
    let found = classify_frame_with(&column, own);
    assert!(
        found
            .iter()
            .flatten()
            .all(|f| f.category != Phone && f.category != Card),
        "{found:?}"
    );
    assert!(date_not_number("2026-11-14 15:21"));
    assert!(date_not_number("2026-11-20 17:39:51.123"));
    assert!(date_not_number("2026-11-"));
    assert!(!date_not_number("+44 7700 900140"));
    assert!(!date_not_number("+1 (436)"));
    assert!(!date_not_number("06-12-34-56 78"));
    let found = classify_line("2026-11-20 17:39:51 call from +44 7700 900140");
    assert!(
        found.iter().any(|f| f.category == Phone && f.start == 30),
        "{found:?}"
    );
}

#[test]
fn a_card_read_short_in_a_card_column_is_still_a_card() {
    let line = |text, y| LineContext {
        text,
        x: 0.62,
        y,
        w: 0.1,
        h: 0.02,
    };
    let lines = [
        line("4242-4242-4242-4242", 0.30),
        line("4111111111111", 0.34),
        line("5555555555554444", 0.38),
        LineContext {
            text: "4111111111111",
            x: 0.1,
            y: 0.34,
            w: 0.08,
            h: 0.02,
        },
        line("2026-11-25 10:42", 0.42),
    ];
    let own = lines.iter().map(|l| classify_line(l.text)).collect();
    let found = classify_frame_with(&lines, own);
    assert!(found[1].iter().any(|f| f.category == Card), "{found:?}");
    assert!(found[3].iter().all(|f| f.category != Card), "{found:?}");
    assert!(found[4].iter().all(|f| f.category != Card), "{found:?}");
}

#[test]
fn words_near_the_word_password_are_not_a_password() {
    let line = |text, y| LineContext {
        text,
        x: 0.2,
        y,
        w: 0.3,
        h: 0.02,
    };
    let suggestions = [
        line("this is my password", 0.10),
        line("this is my password in a game", 0.13),
        line("this is your password", 0.16),
        line("this is my mail password", 0.19),
        line("Passwords", 0.22),
        line("Saved logins", 0.25),
    ];
    let own = suggestions.iter().map(|l| classify_line(l.text)).collect();
    let found = classify_frame_with(&suggestions, own);
    assert!(
        found.iter().flatten().all(|f| f.category != Secret),
        "{found:?}"
    );
    let form = [line("Password", 0.40), line("hunter2xQ9", 0.43)];
    let own = form.iter().map(|l| classify_line(l.text)).collect();
    let found = classify_frame_with(&form, own);
    assert!(found[1].iter().any(|f| f.category == Secret), "{found:?}");
    let row = [
        line("Webhook signing secret", 0.40),
        LineContext {
            text: "Falcon$1458Q",
            x: 0.55,
            y: 0.40,
            w: 0.1,
            h: 0.02,
        },
    ];
    let own = row.iter().map(|l| classify_line(l.text)).collect();
    let found = classify_frame_with(&row, own);
    assert!(found[1].iter().any(|f| f.category == Secret), "{found:?}");
    let masked = [line("Password", 0.40), line("••••••••", 0.43)];
    let own = masked.iter().map(|l| classify_line(l.text)).collect();
    let found = classify_frame_with(&masked, own);
    assert!(found[1].iter().any(|f| f.category == Secret), "{found:?}");
}
