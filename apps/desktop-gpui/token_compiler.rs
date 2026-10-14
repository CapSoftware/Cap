use std::collections::{BTreeMap, BTreeSet};

pub type Declarations = BTreeMap<String, String>;

pub fn parse(css: &str) -> Result<(Declarations, Declarations), String> {
    let mut clean = String::new();
    let mut rest = css;
    while let Some(start) = rest.find("/*") {
        clean.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let end = after.find("*/").ok_or("unterminated CSS comment")?;
        rest = &after[end + 2..];
    }
    clean.push_str(rest);
    let block = |selector: &str| -> Result<Declarations, String> {
        let start = clean
            .find(selector)
            .ok_or_else(|| format!("missing {selector} block"))?
            + selector.len();
        let open = clean[start..]
            .find('{')
            .ok_or_else(|| format!("missing opening brace for {selector}"))?
            + start;
        if !clean[start..open].trim().is_empty() {
            return Err(format!("invalid {selector} selector"));
        }
        let close = clean[open + 1..]
            .find('}')
            .ok_or_else(|| format!("missing closing brace for {selector}"))?
            + open
            + 1;
        let mut declarations = Declarations::new();
        for declaration in clean[open + 1..close].split(';').map(str::trim) {
            if !declaration.starts_with("--") {
                continue;
            }
            let (name, value) = declaration
                .split_once(':')
                .ok_or_else(|| format!("invalid declaration {declaration}"))?;
            let name = name.trim_start_matches("--").trim().to_owned();
            let value = value.trim().to_owned();
            if value.is_empty() || declarations.insert(name.clone(), value).is_some() {
                return Err(format!("empty or duplicate --{name} in {selector}"));
            }
        }
        Ok(declarations)
    };
    Ok((block(":root")?, block(".dark")?))
}

pub fn resolve(values: &Declarations, name: &str) -> Result<String, String> {
    fn inner(
        values: &Declarations,
        name: &str,
        visiting: &mut BTreeSet<String>,
    ) -> Result<String, String> {
        if !visiting.insert(name.to_owned()) {
            return Err(format!("cyclic reference at --{name}"));
        }
        let mut rest = values
            .get(name)
            .ok_or_else(|| format!("missing --{name}"))?
            .as_str();
        let mut result = String::new();
        while let Some(start) = rest.find("var(--") {
            result.push_str(&rest[..start]);
            let reference = &rest[start + 6..];
            let end = reference
                .find(')')
                .ok_or_else(|| format!("unterminated var in --{name}"))?;
            result.push_str(&inner(values, reference[..end].trim(), visiting)?);
            rest = &reference[end + 1..];
        }
        result.push_str(rest);
        visiting.remove(name);
        Ok(result)
    }
    inner(values, name, &mut BTreeSet::new())
}

fn hex(value: &str) -> Result<[u8; 4], String> {
    let raw = value
        .strip_prefix('#')
        .ok_or_else(|| format!("unsupported color {value}"))?;
    let digits = match raw.len() {
        3 | 4 => raw.chars().flat_map(|c| [c, c]).collect::<String>(),
        6 | 8 => raw.to_owned(),
        _ => return Err(format!("unsupported color {value}")),
    };
    let byte = |i: usize| {
        u8::from_str_radix(&digits[i..i + 2], 16).map_err(|_| format!("invalid color {value}"))
    };
    Ok([
        byte(0)?,
        byte(2)?,
        byte(4)?,
        if digits.len() == 8 { byte(6)? } else { 255 },
    ])
}

pub fn color(value: &str) -> Result<[u8; 4], String> {
    let value = value.trim();
    if value.starts_with('#') {
        return hex(value);
    }
    let inside = value
        .strip_prefix("color-mix(")
        .and_then(|s| s.strip_suffix(')'))
        .ok_or_else(|| format!("unsupported color {value}"))?
        .trim()
        .strip_prefix("in srgb,")
        .ok_or_else(|| format!("unsupported color space {value}"))?;
    let (left, right) = inside
        .split_once(',')
        .ok_or_else(|| format!("invalid color-mix {value}"))?;
    let (first, weight) = left
        .trim()
        .rsplit_once(' ')
        .ok_or_else(|| format!("missing color-mix weight {value}"))?;
    let weight: u32 = weight
        .trim()
        .strip_suffix('%')
        .ok_or_else(|| format!("invalid color-mix weight {value}"))?
        .parse()
        .map_err(|_| format!("invalid color-mix weight {value}"))?;
    if weight > 100 {
        return Err(format!("color-mix weight out of range {value}"));
    }
    let first = hex(first.trim())?;
    let second = match right.trim() {
        "transparent" => [0, 0, 0, 0],
        "white" => [255, 255, 255, 255],
        other => hex(other)?,
    };
    let opacity = u32::from(first[3]) * weight + u32::from(second[3]) * (100 - weight);
    if opacity == 0 {
        return Ok([0; 4]);
    }
    let channel = |i| {
        ((u32::from(first[i]) * u32::from(first[3]) * weight
            + u32::from(second[i]) * u32::from(second[3]) * (100 - weight)
            + opacity / 2)
            / opacity) as u8
    };
    Ok([
        channel(0),
        channel(1),
        channel(2),
        ((opacity + 50) / 100) as u8,
    ])
}

pub fn pixels(value: &str) -> Result<f32, String> {
    value
        .trim()
        .strip_suffix("px")
        .ok_or_else(|| format!("invalid pixel value {value}"))?
        .parse()
        .map_err(|_| format!("invalid pixel value {value}"))
}

pub fn shadow(value: &str) -> Result<Vec<([f32; 4], [u8; 4])>, String> {
    let mut layers = Vec::new();
    let mut start = 0;
    let mut depth = 0;
    for (i, c) in value.char_indices() {
        match c {
            '(' => depth += 1,
            ')' => depth -= 1,
            ',' if depth == 0 => {
                layers.push(&value[start..i]);
                start = i + 1;
            }
            _ => {}
        }
        if depth < 0 {
            return Err(format!("unbalanced shadow {value}"));
        }
    }
    if depth != 0 {
        return Err(format!("unbalanced shadow {value}"));
    }
    layers.push(&value[start..]);
    layers
        .into_iter()
        .map(|layer| {
            let start = layer
                .find("color-mix(")
                .ok_or_else(|| format!("missing shadow color {layer}"))?;
            let dimensions = layer[..start]
                .split_whitespace()
                .map(|value| if value == "0" { Ok(0.) } else { pixels(value) })
                .collect::<Result<Vec<_>, _>>()?;
            let dims: [f32; 4] = dimensions
                .try_into()
                .map_err(|_| format!("expected four shadow dimensions {layer}"))?;
            Ok((dims, color(layer[start..].trim())?))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_dark_aliases_and_multiline_mixes() {
        let (light, dark) = parse(
            ":root { --surface: #fff; --brand: #0182fb; --fill: color-mix(\n in srgb,\n var(--brand) 90%,\n transparent\n); } .dark { --surface: #1f1f1f; --fill: var(--surface); }",
        )
        .unwrap();
        assert_eq!(
            color(&resolve(&light, "fill").unwrap()).unwrap(),
            [1, 130, 251, 230]
        );
        let mut cascade = light;
        cascade.extend(dark);
        assert_eq!(
            color(&resolve(&cascade, "fill").unwrap()).unwrap(),
            [31, 31, 31, 255]
        );
    }

    #[test]
    fn rejects_unknown_colors_cycles_and_malformed_shadows() {
        assert!(color("red").is_err());
        assert!(color("color-mix(in srgb, #000 101%, transparent)").is_err());
        assert!(parse(":root { --x: #fff; --x: #000; } .dark {}").is_err());
        let (values, _) = parse(":root { --a: var(--b); --b: var(--a); } .dark {}").unwrap();
        assert!(resolve(&values, "a").is_err());
        assert!(shadow("0 1px 2px color-mix(in srgb, #000 10%, transparent)").is_err());
    }

    #[test]
    fn shadow_layers_preserve_fractional_offsets_and_alpha() {
        let layers = shadow(
            "0 2.75px 5.5px 0 color-mix(in srgb, #000000 10%, transparent), 0 1px 2px -3px color-mix(in srgb, #101828 20%, transparent)",
        )
        .unwrap();
        assert_eq!(layers.len(), 2);
        assert_eq!(layers[0].0, [0., 2.75, 5.5, 0.]);
        assert_eq!(layers[0].1, [0, 0, 0, 26]);
        assert_eq!(layers[1].0[3], -3.);
    }
}
