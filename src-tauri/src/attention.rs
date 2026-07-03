// attention — OS-level "the fleet needs you" surface (Plan 011).
//
// Two Windows taskbar affordances, both driven from TS (attentionEscape owns
// the decision logic; this is the thin native arm):
//   - `set_needs_you_badge(count)`: an overlay badge on the taskbar button
//     showing the fleet needs-you count (1..=9, then "9+").
//   - `flash_taskbar()`: a one-shot, focus-preserving taskbar flash.
//
// HARD RULE: attention code must never crash the app. Every native call here
// is best-effort — a missing window or a platform failure is a silent no-op,
// never an error propagated to the caller.
//
// Badge glyph: composed as a 16x16 RGBA buffer at RUNTIME (an accent disc + a
// white numeral drawn from a tiny embedded 3x5 bitmap font) rather than shipping
// pre-rendered PNGs. This needs no image-format Cargo features and — crucially —
// makes the rasterizer a pure function we unit-test directly. `set_overlay_icon`
// is Windows-only in Tauri, so the command is cfg-gated and no-ops elsewhere;
// Lume is Windows-first and the TS layer above is platform-agnostic.

use tauri::{AppHandle, Manager, Runtime};

/// Overlay icon edge, in pixels. Windows renders taskbar overlays at 16x16.
const BADGE_PX: usize = 16;

/// Accent disc color (opaque red) — a saturated, high-contrast "attention" hue
/// that reads on both light and dark taskbars. The numeral is drawn white on it.
const DISC_RGBA: [u8; 4] = [0xE5, 0x48, 0x4D, 0xFF];
/// Numeral color.
const INK_RGBA: [u8; 4] = [0xFF, 0xFF, 0xFF, 0xFF];

/// 3x5 bitmap font, digits 0-9. Each row is a bitmask where bit 2 is the
/// leftmost column and bit 0 the rightmost.
const DIGITS: [[u8; 5]; 10] = [
    [0b111, 0b101, 0b101, 0b101, 0b111], // 0
    [0b010, 0b110, 0b010, 0b010, 0b111], // 1
    [0b111, 0b001, 0b111, 0b100, 0b111], // 2
    [0b111, 0b001, 0b111, 0b001, 0b111], // 3
    [0b101, 0b101, 0b111, 0b001, 0b001], // 4
    [0b111, 0b100, 0b111, 0b001, 0b111], // 5
    [0b111, 0b100, 0b111, 0b101, 0b111], // 6
    [0b111, 0b001, 0b010, 0b010, 0b010], // 7
    [0b111, 0b101, 0b111, 0b101, 0b111], // 8
    [0b111, 0b101, 0b111, 0b001, 0b111], // 9
];
/// 3x5 "+" glyph, used for the "9+" overflow badge.
const PLUS: [u8; 5] = [0b000, 0b010, 0b111, 0b010, 0b000];

/// The numeral to draw for a count, as 5 row-masks plus the total glyph width.
/// 1..=9 → the single digit (width 3). >=10 → "9" + 1-col gap + "+" (width 7),
/// packed into a u16 so both glyphs share one mask per row.
fn glyph_rows(count: u32) -> ([u16; 5], usize) {
    if count <= 9 {
        let d = DIGITS[count as usize];
        (
            [
                d[0] as u16,
                d[1] as u16,
                d[2] as u16,
                d[3] as u16,
                d[4] as u16,
            ],
            3,
        )
    } else {
        let nine = DIGITS[9];
        let mut rows = [0u16; 5];
        for i in 0..5 {
            // "9" in bits 6..4, one blank gap column in bit 3, "+" in bits 2..0.
            rows[i] = ((nine[i] as u16) << 4) | (PLUS[i] as u16);
        }
        (rows, 7)
    }
}

/// Paint one pixel (bounds-checked; out-of-range is ignored).
fn put(buf: &mut [u8], x: usize, y: usize, rgba: [u8; 4]) {
    if x >= BADGE_PX || y >= BADGE_PX {
        return;
    }
    let i = (y * BADGE_PX + x) * 4;
    buf[i..i + 4].copy_from_slice(&rgba);
}

/// Compose the 16x16 RGBA badge for `count` (caller guarantees count >= 1): an
/// accent disc with a centered white numeral. Pure — this is the unit-tested
/// heart of the badge. Row-major, top-to-bottom, matching `Image::new_owned`.
pub fn render_badge_rgba(count: u32) -> Vec<u8> {
    let n = BADGE_PX as i32;
    let mut buf = vec![0u8; BADGE_PX * BADGE_PX * 4];

    // Disc: radius (n-1)/2 about the pixel-grid center, using doubled integer
    // coordinates so the half-pixel center needs no floats. Nearly fills the
    // square, touching the edges at the midpoints.
    let r2 = (n - 1) * (n - 1);
    for y in 0..BADGE_PX {
        for x in 0..BADGE_PX {
            let dx = (x as i32) * 2 - (n - 1);
            let dy = (y as i32) * 2 - (n - 1);
            if dx * dx + dy * dy <= r2 {
                put(&mut buf, x, y, DISC_RGBA);
            }
        }
    }

    // Numeral: pick the largest integer scale that keeps the glyph inside the
    // disc's inscribed square (~11px for a 16px disc), then center + blit.
    let (rows, w) = glyph_rows(count);
    let h = 5usize;
    let scale = usize::max(1, usize::min(11 / w, 11 / h));
    let gw = w * scale;
    let gh = h * scale;
    let ox = (BADGE_PX - gw) / 2;
    let oy = (BADGE_PX - gh) / 2;
    for (ry, mask) in rows.iter().enumerate() {
        for rx in 0..w {
            let on = (mask >> (w - 1 - rx)) & 1 == 1;
            if !on {
                continue;
            }
            for sy in 0..scale {
                for sx in 0..scale {
                    put(
                        &mut buf,
                        ox + rx * scale + sx,
                        oy + ry * scale + sy,
                        INK_RGBA,
                    );
                }
            }
        }
    }
    buf
}

/// Set (or clear, when `count == 0`) the taskbar overlay badge. Idempotent;
/// a missing window or any platform failure is a silent no-op.
#[tauri::command]
pub fn set_needs_you_badge<R: Runtime>(app: AppHandle<R>, count: u32) {
    #[cfg(target_os = "windows")]
    {
        let Some(win) = app.get_webview_window("main") else {
            return;
        };
        if count == 0 {
            let _ = win.set_overlay_icon(None);
        } else {
            let img = tauri::image::Image::new_owned(
                render_badge_rgba(count),
                BADGE_PX as u32,
                BADGE_PX as u32,
            );
            let _ = win.set_overlay_icon(Some(img));
        }
    }
    // Non-Windows: overlay badges are unsupported by the OS; no-op.
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (&app, count);
    }
}

/// Flash the taskbar button once, without stealing focus. The flash stops on
/// its own when the user focuses Lume (OS behavior). Silent no-op on failure.
#[tauri::command]
pub fn flash_taskbar<R: Runtime>(app: AppHandle<R>) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.request_user_attention(Some(tauri::UserAttentionType::Informational));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LEN: usize = BADGE_PX * BADGE_PX * 4;

    fn px(buf: &[u8], x: usize, y: usize) -> [u8; 4] {
        let i = (y * BADGE_PX + x) * 4;
        [buf[i], buf[i + 1], buf[i + 2], buf[i + 3]]
    }

    #[test]
    fn buffer_is_16x16_rgba_for_every_count() {
        for count in [1u32, 2, 5, 9, 10, 42, 999] {
            assert_eq!(render_badge_rgba(count).len(), LEN, "count {count}");
        }
    }

    #[test]
    fn disc_is_opaque_at_center_transparent_at_corners() {
        let buf = render_badge_rgba(3);
        // Center is inside the disc.
        assert_eq!(px(&buf, 8, 8)[3], 0xFF);
        // The four corners fall outside the disc → fully transparent.
        for &(x, y) in &[(0usize, 0usize), (15, 0), (0, 15), (15, 15)] {
            assert_eq!(px(&buf, x, y)[3], 0x00, "corner ({x},{y}) should be clear");
        }
    }

    #[test]
    fn single_digit_and_overflow_both_draw_white_ink() {
        for count in [1u32, 9, 10, 128] {
            let buf = render_badge_rgba(count);
            let has_ink = (0..BADGE_PX * BADGE_PX).any(|p| buf[p * 4..p * 4 + 4] == INK_RGBA);
            assert!(has_ink, "count {count} drew no numeral");
        }
    }

    #[test]
    fn overflow_uses_the_seven_wide_glyph() {
        // 1..=9 pack width 3; >=10 packs width 7 ("9" + gap + "+").
        assert_eq!(glyph_rows(1).1, 3);
        assert_eq!(glyph_rows(9).1, 3);
        assert_eq!(glyph_rows(10).1, 7);
        assert_eq!(glyph_rows(10_000).1, 7);
    }

    #[test]
    fn ink_never_lands_outside_the_disc() {
        // Every white pixel must sit on an opaque disc pixel — no numeral pixel
        // may float on the transparent background (legibility guarantee).
        let n = BADGE_PX as i32;
        let r2 = (n - 1) * (n - 1);
        for count in [1u32, 8, 10] {
            let buf = render_badge_rgba(count);
            for y in 0..BADGE_PX {
                for x in 0..BADGE_PX {
                    if px(&buf, x, y) != INK_RGBA {
                        continue;
                    }
                    let dx = (x as i32) * 2 - (n - 1);
                    let dy = (y as i32) * 2 - (n - 1);
                    assert!(
                        dx * dx + dy * dy <= r2,
                        "ink at ({x},{y}) off-disc (count {count})"
                    );
                }
            }
        }
    }
}
