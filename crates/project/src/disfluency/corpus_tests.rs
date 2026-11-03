use super::*;

/// Hand-labelled narration in the style of screen recordings: tutorials,
/// walkthroughs, bug reports and team updates. A bracket marks what a careful
/// editor would cut and why: `[H ...]` hesitation, `[R ...]` repeated words,
/// `[F ...]` false start, `[D ...]` discourse filler. `|` is a pause of more
/// than a second. Lines with no brackets are there to catch false alarms,
/// most of them using "like", "so", "actually", "you know" and friends in
/// their ordinary sense.
const CORPUS: &str = r#"
[D So,] [H um,] today I want to show you how exports work.
[H Uh,] let me open the settings first.
I like pizza, but I prefer pasta.
It looks like the upload finished.
[R We] we just shipped the new editor.
[R The] the button is in the top right corner.
[D Okay,] [D so] let's get started.
[D Basically,] you drag the clip onto the timeline.
It was, [D like,] really slow before the fix.
This is what I meant by a clean cut.
I think, [H um,] I can fix that later today.
[F We should,] [H uh,] we need to restart the server.
[F It was-] it is really simple once you see it.
You can see [F the wh-] the waveform here.
That makes sense, [D right?]
Is that right?
Turn right at the second menu.
Would you like to try it yourself?
Just like that, the clip is gone.
So far so good.
So much for the old workflow.
We saved the file so we could share it.
It was so fast that I missed it.
[D Well,] that is all for today.
Well done to the whole team.
[D Actually,] this setting matters a lot.
It actually works on Windows now.
The video was literally three seconds long.
[D Honestly,] I did not expect that.
[D I mean,] it works, but it is slow.
What I mean is that the cache is stale.
I mean it when I say thank you.
It was hard to debug, [D you know?]
[D You know,] this used to take an hour.
You know how to do this already.
Do you know where the export went?
You know what to click next.
It is kind of cool how fast it is.
It was, [D kind of,] a mess before.
This is a different sort of tool.
She had had enough of the old editor.
I know that that is confusing.
No no no, not that one.
Dial nine one one if it catches fire.
The build number is 4 4 2.
It is very very fast now.
That was really really helpful, thanks.
[H Hmm,] where did that file go?
[H Ummm] let me think about that.
[H Uhhh] I forgot the password.
[H Er,] the second option, sorry.
[H Erm,] maybe the third one.
[H Ah,] there it is.
Uh-huh, that is exactly right.
Mm-hmm, I agree with that.
The umbrella icon is the weather setting.
[D Okay.] Let's look at the timeline.
It was okay, nothing special.
[D Right,] [D so] the next step is captions.
[D All right,] let's move on.
All right answers get a green tick.
[R I] I think this is the last bug.
[R We we] we finally fixed it.
[R I want to,] [H um,] I want to show you this part.
Click on [R the,] [H uh,] the export button.
[R Of the] of the three options, pick the first.
[F I was gonna,] [H uh,] I am going to skip this.
[F The thing,] [H um,] the main thing is speed.
The thing is, [H uh,] the server was down.
I went home and I slept.
[D So] today we are talking about captions.
[D So] I opened the project and it crashed.
So what do we do now?
We went home, so we rested.
| [D So] the next part is the timeline.
I like how clean this looks.
It feels like, [H um,] forever since the last release.
[D Like,] I do not even know what happened.
They were, [D like,] five minutes late.
Things like apples and oranges are fruit.
The new UI is like the old one.
[D Basically,] [D like,] you just press record.
And then, [H um,] you press stop.
[H Uh,] [D so,] where was I?
You can, [H um,] trim the start here.
[R It] it should be fine.
Bye bye for now.
[D Okay,] [D so] [D basically,] that is the whole flow.
We tested it | it worked on the first try.
Go. Go now before it closes.
[H Um] [H uh] [H um] I lost my train of thought.
[F My-] my microphone was muted.
[F The c-] the camera was off.
I have the code here. [D So] let me paste it.
It is what it is.
What it is is a cache.
Do not do that.
[R That] that way is wrong, so we changed it.
He said that that was fine.
[R They] they did not answer.
[R This is] this is the important bit.
[F This is,] [H uh,] this was a problem last week.
I can see it on the right side.
Right now the export is faster.
Okay is the default button.
The okay button is disabled.
I was like, wow, that is fast.
She was like no, that is wrong.
[D You know what I mean?] It just works.
[D I mean,] [D you know,] it is fine.
Literally everyone asked for this feature.
It is literally the best update so far.
[D Actually,] [H um,] let me go back.
Actually the first one was better.
This actually matters for long recordings.
It works, actually.
I sort of see what you mean.
[R So] [D so] the first step is the upload.
[H Mmm,] not quite.
[H Hmm] interesting.
[H Ehm,] I am not sure.
I think [R the] the second clip is shorter.
Let me just, [H uh,] zoom in a bit.
We need to, [H um,] check the logs.
Can you, [H er,] share your screen?
[R You can] you can drag it here.
[F If you,] [H um,] if we look at the graph it is clear.
[F And we,] [H uh,] and then we saw the spike.
[R So the,] [H um,] so the result was faster.
It is a kind of shortcut for power users.
The kind of feedback we want is honest.
He is kind of right about that.
Basically everything works now.
That is basically it.
Honestly I think it is fine.
Seriously, this is great.
We really need to talk about pricing.
I did not like the old icons.
The like button moved to the left.
There are like five ways to do this.
[D Well,] [H um,] I guess that is it.
Well, well, look at that.
Well it depends on the project.
That went well.
[D So,] so many people asked for this.
[D So] yeah, that is the update.
[H Uh] [D so] [D okay,] here we go.
The video is about ten minutes long.
It was a long long time ago.
Many many thanks to everyone.
We met at nine and talked until ten.
I said no, and I meant no.
It was [R the] the best version we shipped.
Please, please send me the logs.
He tried and tried and tried.
Again and again it crashed.
Step by step it gets easier.
Day by day the queue shrinks.
Right click the clip to split it.
The right answer is the second one.
Click right here.
That is right, the second one.
It is not right yet.
Is it okay if I share this?
Everything is okay now.
[D Okay] [D so] the timeline is loaded.
"#;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
struct Gold(Option<DisfluencyKind>);

fn kind_for(letter: char) -> DisfluencyKind {
    match letter {
        'H' => DisfluencyKind::Hesitation,
        'R' => DisfluencyKind::Repetition,
        'F' => DisfluencyKind::FalseStart,
        'D' => DisfluencyKind::Discourse,
        other => panic!("unknown label {other}"),
    }
}

fn parse_line(line: &str) -> Vec<(String, f64, f64, Gold)> {
    let mut out = Vec::new();
    let mut time = 0.0;
    let mut open: Option<DisfluencyKind> = None;
    for raw in line.split_whitespace() {
        if raw == "|" {
            time += 1.4;
            continue;
        }
        let mut text = raw;
        if let Some(rest) = text.strip_prefix('[') {
            open = Some(kind_for(rest.chars().next().expect("label")));
            continue;
        }
        let closes = text.ends_with(']');
        if closes {
            text = &text[..text.len() - 1];
        }
        out.push((text.to_string(), time, time + 0.24, Gold(open)));
        time += 0.3;
        if closes {
            open = None;
        }
    }
    out
}

#[derive(Default, Debug, Clone, Copy)]
struct Score {
    true_positive: usize,
    false_positive: usize,
    false_negative: usize,
}

impl Score {
    fn precision(self) -> f64 {
        let predicted = self.true_positive + self.false_positive;
        if predicted == 0 {
            1.0
        } else {
            self.true_positive as f64 / predicted as f64
        }
    }

    fn recall(self) -> f64 {
        let actual = self.true_positive + self.false_negative;
        if actual == 0 {
            1.0
        } else {
            self.true_positive as f64 / actual as f64
        }
    }
}

fn evaluate() -> (Vec<(DisfluencyKind, Score)>, Score, Vec<String>) {
    let mut scores: Vec<(DisfluencyKind, Score)> = DisfluencyKind::ALL
        .iter()
        .map(|kind| (*kind, Score::default()))
        .collect();
    let mut removal = Score::default();
    let mut mistakes = Vec::new();
    for line in CORPUS.lines().filter(|line| !line.trim().is_empty()) {
        let parsed = parse_line(line);
        let tokens: Vec<_> = parsed
            .iter()
            .map(|(text, start, end, _)| DisfluencyToken {
                text,
                start: *start,
                end: *end,
            })
            .collect();
        let mut predicted = vec![None; parsed.len()];
        for found in detect_disfluencies(&tokens) {
            for slot in &mut predicted[found.words] {
                *slot = Some(found.kind);
            }
        }
        for ((text, _, _, Gold(gold)), predicted) in parsed.iter().zip(&predicted) {
            match (gold, predicted) {
                (Some(_), Some(_)) => removal.true_positive += 1,
                (None, Some(_)) => removal.false_positive += 1,
                (Some(_), None) => removal.false_negative += 1,
                (None, None) => {}
            }
            for (kind, score) in &mut scores {
                let is_gold = *gold == Some(*kind);
                let is_predicted = *predicted == Some(*kind);
                match (is_gold, is_predicted) {
                    (true, true) => score.true_positive += 1,
                    (false, true) => score.false_positive += 1,
                    (true, false) => score.false_negative += 1,
                    (false, false) => {}
                }
            }
            if *gold != *predicted {
                mistakes.push(format!(
                    "{text:?}: expected {gold:?}, found {predicted:?} in {line:?}"
                ));
            }
        }
    }
    (scores, removal, mistakes)
}

#[test]
fn corpus_precision_and_recall_per_category() {
    let (scores, removal, mistakes) = evaluate();
    let report = scores
        .iter()
        .map(|(kind, score)| {
            format!(
                "{kind:?}: precision {:.3} recall {:.3} ({score:?})",
                score.precision(),
                score.recall()
            )
        })
        .chain([format!(
            "Any removal: precision {:.3} recall {:.3} ({removal:?})",
            removal.precision(),
            removal.recall()
        )])
        .collect::<Vec<_>>()
        .join("\n");
    println!("{report}\n{}", mistakes.join("\n"));

    for (kind, score) in &scores {
        let (min_precision, min_recall) = match kind {
            DisfluencyKind::Hesitation => (1.0, 1.0),
            DisfluencyKind::Repetition => (0.95, 0.9),
            DisfluencyKind::FalseStart => (0.9, 0.8),
            DisfluencyKind::Discourse => (0.95, 0.75),
        };
        assert!(
            score.precision() >= min_precision && score.recall() >= min_recall,
            "{report}\n{}",
            mistakes.join("\n")
        );
    }
    assert!(
        removal.precision() >= 0.97,
        "{report}\n{}",
        mistakes.join("\n")
    );
}

#[test]
fn corpus_has_enough_of_every_category() {
    let mut counts = [0usize; 4];
    let mut negatives = 0;
    for line in CORPUS.lines().filter(|line| !line.trim().is_empty()) {
        let parsed = parse_line(line);
        if parsed.iter().all(|(.., gold)| gold.0.is_none()) {
            negatives += 1;
        }
        for (.., Gold(gold)) in parsed {
            if let Some(kind) = gold {
                counts[kind.priority() as usize] += 1;
            }
        }
    }
    assert!(counts.iter().all(|count| *count >= 10), "{counts:?}");
    assert!(negatives >= 60, "{negatives}");
}
