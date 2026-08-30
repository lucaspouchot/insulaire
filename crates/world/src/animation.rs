//! Animation: how a character's nodes move over time.
//!
//! A character is a tree of layers with a rest pose written into their boxes
//! (`character.rs`). An animation says nothing about *what* is drawn — it is a
//! list of **offsets from that rest pose**, per node, per frame:
//!
//! ```text
//! CharacterDefinition (nodes, rest pose)  ──┐
//!                                           ├──> resolve_at() ──> ResolvedCharacter
//! Animation (offsets over time)  ───────────┘
//! ```
//!
//! That is the whole idea, and it is what keeps a walk cycle from being thirty
//! copies of a character: a definition with thirty layers and ten animations
//! stores ten *lists of what moved*, not three hundred positions.
//!
//! # Tracks, not frames
//!
//! An animation is a set of [`AnimationTrack`]s — one per node that moves at
//! all — and each holds [`Keyframe`]s at the frames where that node changes.
//! A node with no track does not sit still: it follows its parent, because the
//! offsets compose down the tree (`CharacterDefinition::resolve_at`). Making
//! the body breathe is four keyframes on one track, and the head, the hair and
//! the arms breathe with it.
//!
//! # Poses, not sprite ids
//!
//! Movement is only half of an animation: a walk cycle also *redraws* the legs,
//! and a character seen from the side is drawn from different art entirely. An
//! animation says which by setting **pose values** — an ordinary key/value map
//! that joins the customisation for the moment it is in force, so a layer picks
//! its sprite through the same `when` conditions it already uses for hair
//! colour or armour (`docs/adr/ADR-0025-characters-animate-by-hierarchy-and-offsets.md`).
//!
//! [`Animation::pose`] holds for the whole animation (`view: side`), and
//! [`Animation::poses`] overrides it frame by frame (`step: contact`). A
//! keyframe never names a variant: naming one would make the animation choose
//! for a single layer, and the choice would then have to be repeated for every
//! build, every armour and every size that layer already varies with.
//!
//! # Everything is whole pixels
//!
//! A [`Transform`] is a translation in canvas pixels and nothing else. Rotation
//! and scale are absent on purpose: rotating pixel art resamples it, and
//! resampling is what ADR-0024 exists to prevent
//! (`docs/adr/ADR-0025-characters-animate-by-hierarchy-and-offsets.md`). The
//! shape that leaves room for them is [`Transform`] itself — a node's local
//! transform is *a struct*, so a rotation is a field appearing there rather
//! than a change to what a keyframe is.
//!
//! # Time, not frames
//!
//! Evaluation takes a time in milliseconds, so the editor's preview and a game
//! loop ask the same question of the same code. Frames are how an author
//! *writes* an animation; milliseconds are how anything *plays* one.

use std::{collections::BTreeMap, str::FromStr};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::HexDirection;

/// Most frames an animation may declare.
///
/// A cap rather than a preference: four seconds at 60 frames a second is a long
/// sprite animation, and a file asking for ten thousand frames is a mistake
/// nobody wants to discover as a timeline the browser cannot draw.
pub const MAX_ANIMATION_FRAMES: u32 = 240;

/// How long one frame lasts when a file names no duration.
///
/// Roughly eight frames a second — the pace hand-drawn sprite animation is
/// usually authored at, and slow enough that a four-frame idle reads as
/// breathing rather than as a flicker.
pub const DEFAULT_FRAME_DURATION_MS: u32 = 120;

/// Most frames one **flipbook** may declare.
///
/// A flipbook is the other way this crate animates: one whole image per frame,
/// played at a fixed rate, which is how a decoration flickers and how an object
/// icon glints ([`crate::DecorationAnimation`], [`crate::ObjectDefinition`]).
/// It is a cap rather than a preference — every frame is a *separate PNG* here,
/// not a row of offsets, so sixty-four is already a folder of sixty-four files
/// and a file asking for a thousand is a mistake, not a flame.
pub const MAX_FLIPBOOK_FRAMES: usize = 64;

/// How long one full play of a flipbook takes, in milliseconds.
#[must_use]
pub fn flipbook_duration_ms(frames: usize, frame_duration_ms: u32) -> u32 {
    u32::try_from(frames)
        .unwrap_or(u32::MAX)
        .saturating_mul(frame_duration_ms)
}

/// Which frame of a flipbook this time falls in, `0`-based.
///
/// A looping flipbook wraps; one that does not holds its **last** frame, which
/// is what makes a one-shot state stay in the state it reached — the same rule
/// [`Animation::position_at`] follows for a skeleton.
///
/// Written once, here, so a decoration and an object cannot disagree about
/// which drawing is on screen at 250ms.
#[must_use]
pub fn flipbook_index_at(
    frames: usize,
    frame_duration_ms: u32,
    looping: bool,
    time_ms: u32,
) -> usize {
    if frames == 0 || frame_duration_ms == 0 {
        return 0;
    }
    let duration = flipbook_duration_ms(frames, frame_duration_ms);
    let elapsed = if looping {
        time_ms % duration.max(1)
    } else {
        time_ms.min(duration.saturating_sub(1))
    };
    ((elapsed / frame_duration_ms) as usize).min(frames - 1)
}

/// The gameplay situation an animation illustrates.
///
/// Ids stay author-owned: a cycle called `shuffle` can be the idle and one
/// called `stride` can be movement to the west. This role is the validated seam
/// gameplay uses instead of guessing from either name
/// (`docs/adr/ADR-0030-gameplay-selects-character-animations-by-role.md`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AnimationRole {
    /// The character is not moving.
    Idle,
    /// Generic movement facing left, the fallback for the three western directions.
    MoveLeft,
    /// Generic movement facing right, the fallback for the three eastern directions.
    MoveRight,
    /// Movement to the axial east neighbour.
    MoveEast,
    /// Movement to the axial north-east neighbour.
    MoveNorthEast,
    /// Movement to the axial north-west neighbour.
    MoveNorthWest,
    /// Movement to the axial west neighbour.
    MoveWest,
    /// Movement to the axial south-west neighbour.
    MoveSouthWest,
    /// Movement to the axial south-east neighbour.
    MoveSouthEast,
}

impl AnimationRole {
    /// The exact movement role for a hex direction.
    #[must_use]
    pub const fn for_direction(direction: HexDirection) -> Self {
        match direction {
            HexDirection::East => Self::MoveEast,
            HexDirection::NorthEast => Self::MoveNorthEast,
            HexDirection::NorthWest => Self::MoveNorthWest,
            HexDirection::West => Self::MoveWest,
            HexDirection::SouthWest => Self::MoveSouthWest,
            HexDirection::SouthEast => Self::MoveSouthEast,
        }
    }

    /// The two-direction role used when no exact movement animation exists.
    #[must_use]
    pub const fn fallback(self) -> Option<Self> {
        match self {
            Self::MoveEast | Self::MoveNorthEast | Self::MoveSouthEast => Some(Self::MoveRight),
            Self::MoveWest | Self::MoveNorthWest | Self::MoveSouthWest => Some(Self::MoveLeft),
            Self::Idle | Self::MoveLeft | Self::MoveRight => None,
        }
    }

    /// The camel-case value written in character JSON and sent across WASM.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::MoveLeft => "moveLeft",
            Self::MoveRight => "moveRight",
            Self::MoveEast => "moveEast",
            Self::MoveNorthEast => "moveNorthEast",
            Self::MoveNorthWest => "moveNorthWest",
            Self::MoveWest => "moveWest",
            Self::MoveSouthWest => "moveSouthWest",
            Self::MoveSouthEast => "moveSouthEast",
        }
    }
}

impl FromStr for AnimationRole {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "idle" => Ok(Self::Idle),
            "moveLeft" => Ok(Self::MoveLeft),
            "moveRight" => Ok(Self::MoveRight),
            "moveEast" => Ok(Self::MoveEast),
            "moveNorthEast" => Ok(Self::MoveNorthEast),
            "moveNorthWest" => Ok(Self::MoveNorthWest),
            "moveWest" => Ok(Self::MoveWest),
            "moveSouthWest" => Ok(Self::MoveSouthWest),
            "moveSouthEast" => Ok(Self::MoveSouthEast),
            _ => Err(format!("unknown character animation role `{value}`")),
        }
    }
}

/// A translation in whole canvas pixels: `[x, y]`.
///
/// The same units and the same reasoning as `PixelRect`: a sprite moved by
/// half a pixel is a sprite with a seam down its middle.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct PixelOffset(pub [i32; 2]);

impl PixelOffset {
    /// An offset from its two components.
    #[must_use]
    pub const fn new(x: i32, y: i32) -> Self {
        Self([x, y])
    }

    /// Horizontal component, positive to the right.
    #[must_use]
    pub const fn x(self) -> i32 {
        self.0[0]
    }

    /// Vertical component, positive **downwards** — canvas coordinates.
    #[must_use]
    pub const fn y(self) -> i32 {
        self.0[1]
    }

    /// `true` when this offset moves nothing.
    #[must_use]
    pub const fn is_zero(self) -> bool {
        self.x() == 0 && self.y() == 0
    }

    /// The two offsets applied one after the other.
    ///
    /// This is what "a child inherits its parent's movement" *is*: composing
    /// translations is adding them, so a body that drops two pixels drops
    /// everything hanging off it by two pixels.
    #[must_use]
    pub const fn compose(self, other: Self) -> Self {
        Self([self.x() + other.x(), self.y() + other.y()])
    }
}

/// A node's transform for one keyframe, relative to its rest pose.
///
/// One field today. It is a struct rather than a bare offset because the model
/// has to have somewhere for a rotation to go the day the renderer can honour
/// one without resampling — the same reasoning that made a layer's image a
/// `Sprite` rather than a path
/// (`docs/adr/ADR-0025-characters-animate-by-hierarchy-and-offsets.md`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Transform {
    /// Translation from the rest pose, in canvas pixels.
    #[serde(default)]
    pub offset: PixelOffset,
}

impl Transform {
    /// A transform that only moves.
    #[must_use]
    pub const fn at(x: i32, y: i32) -> Self {
        Self {
            offset: PixelOffset::new(x, y),
        }
    }

    /// A transform that changes nothing.
    #[must_use]
    pub const fn identity() -> Self {
        Self {
            offset: PixelOffset::new(0, 0),
        }
    }

    /// `true` when applying this transform is the same as not applying it.
    #[must_use]
    pub const fn is_identity(self) -> bool {
        self.offset.is_zero()
    }

    /// This transform applied on top of `parent`'s.
    #[must_use]
    pub const fn compose(self, parent: Self) -> Self {
        Self {
            offset: parent.offset.compose(self.offset),
        }
    }

    /// A point `fraction` of the way from this transform to `other`.
    ///
    /// Rounded back to whole pixels, because that is the only thing the
    /// renderer can draw: interpolation buys smoother *timing*, never a
    /// fractional position.
    #[must_use]
    pub fn lerp(self, other: Self, fraction: f64) -> Self {
        let mix = |from: i32, to: i32| {
            (f64::from(from) + (f64::from(to) - f64::from(from)) * fraction).round() as i32
        };
        Self {
            offset: PixelOffset::new(
                mix(self.offset.x(), other.offset.x()),
                mix(self.offset.y(), other.offset.y()),
            ),
        }
    }
}

/// How a keyframe reaches the one after it.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Default, Serialize, Deserialize,
)]
#[serde(rename_all = "camelCase")]
pub enum Interpolation {
    /// Hold this value until the next keyframe, then jump. The default, and
    /// what hand-drawn sprite animation actually does.
    #[default]
    Step,
    /// Move evenly towards the next keyframe's value.
    Linear,
}

/// One node's value at one frame.
///
/// The transform is flattened into the keyframe, so a file reads
/// `{ "frame": 1, "offset": [0, -2] }` rather than nesting a `transform`
/// object around two numbers. The *type* keeps the concept; the file keeps the
/// diff readable.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Keyframe {
    /// Which frame of the animation this value is written at, `0`-based.
    pub frame: u32,
    /// The node's local transform at that frame.
    #[serde(flatten, default)]
    pub transform: Transform,
    /// How it reaches the next keyframe of its track.
    #[serde(default, skip_serializing_if = "is_step")]
    pub interpolation: Interpolation,
}

fn is_step(interpolation: &Interpolation) -> bool {
    matches!(interpolation, Interpolation::Step)
}

/// The pose values one frame of an animation sets.
///
/// The values are flattened into the entry, so a file reads
/// `{ "frame": 1, "step": "pass" }` rather than nesting a `values` object
/// around one pair. One line per frame is the whole point: a four-frame walk
/// cycle declares its four leg poses in four lines, and every layer that has
/// something to say about a `step` answers all four of them at once.
///
/// `frame` is therefore the one key a pose may not use; serde reads it as the
/// frame number.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PoseKey {
    /// Which frame of the animation these values are set at, `0`-based.
    pub frame: u32,
    /// What they are, laid over the animation's own [`Animation::pose`].
    #[serde(flatten)]
    pub values: BTreeMap<String, Value>,
}

/// Everything one node does over the course of an animation.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnimationTrack {
    /// Id of the layer this track drives.
    pub node: String,
    /// The values it takes, at the frames it takes them.
    #[serde(default)]
    pub keyframes: Vec<Keyframe>,
}

impl AnimationTrack {
    /// The local transform this track holds at `position`, in frames.
    ///
    /// Outside its keyframes the track *holds*: before the first it is the
    /// first value, after the last it is the last one. That is what lets a
    /// track say "the arm swings between frames 2 and 5" without also having
    /// to say what it does for the rest of the animation.
    ///
    /// `wrap` is the animation's length in frames for a looping animation, so
    /// a `Linear` track can travel from its last keyframe back to its first
    /// rather than snapping.
    #[must_use]
    pub fn transform_at(&self, position: f64, wrap: Option<f64>) -> Transform {
        let Some(previous) = self.previous(position) else {
            // Every value lies ahead: hold the first one.
            return self
                .keyframes
                .iter()
                .min_by_key(|keyframe| keyframe.frame)
                .map(|keyframe| keyframe.transform)
                .unwrap_or_default();
        };
        if previous.interpolation == Interpolation::Step {
            return previous.transform;
        }

        let Some((next, at)) = self.next(previous.frame, wrap) else {
            return previous.transform;
        };
        let span = at - f64::from(previous.frame);
        if span <= 0.0 {
            return previous.transform;
        }
        let fraction = ((position - f64::from(previous.frame)) / span).clamp(0.0, 1.0);
        previous.transform.lerp(next.transform, fraction)
    }

    /// The last keyframe at or before `position`.
    fn previous(&self, position: f64) -> Option<&Keyframe> {
        self.keyframes
            .iter()
            .filter(|keyframe| f64::from(keyframe.frame) <= position)
            // Ties go to whichever was written last, the same rule a duplicate
            // anything follows here — and validation reports the duplicate.
            .reduce(|best, keyframe| {
                if keyframe.frame >= best.frame {
                    keyframe
                } else {
                    best
                }
            })
    }

    /// The keyframe after `frame`, and the position it sits at.
    ///
    /// For a looping animation with nothing after it, that is the *first*
    /// keyframe, one full length away.
    fn next(&self, frame: u32, wrap: Option<f64>) -> Option<(&Keyframe, f64)> {
        let ahead = self
            .keyframes
            .iter()
            .filter(|keyframe| keyframe.frame > frame)
            .min_by_key(|keyframe| keyframe.frame);
        if let Some(keyframe) = ahead {
            return Some((keyframe, f64::from(keyframe.frame)));
        }
        let length = wrap?;
        let first = self
            .keyframes
            .iter()
            .min_by_key(|keyframe| keyframe.frame)?;
        Some((first, f64::from(first.frame) + length))
    }
}

/// A named movement a character can play.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Animation {
    /// Stable id, unique within the definition — `idle`, `walk`, `attack`.
    pub id: String,
    /// Name shown in the editor. Not player-facing text, so not a key.
    #[serde(default)]
    pub name: String,
    /// Gameplay situation this animation illustrates.
    ///
    /// Optional because animations may exist only for a portrait, cutscene or
    /// editor preview. Gameplay selects this field and never interprets the id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<AnimationRole>,
    /// Id of the animation this one is the **mirror image** of.
    ///
    /// A character that walks left walks right the same way, seen the other way
    /// round. Rather than author the second one, an animation may say it *is*
    /// the first one flipped: it takes its source's timing, its tracks and its
    /// sprites, and the whole canvas is drawn mirrored. Nothing else about it
    /// is read — its own `frames`, `tracks` and `looping` are ignored.
    ///
    /// A mirror of a mirror is refused (`character.chainedMirror`), which is
    /// what keeps this one hop rather than a chain to walk.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mirror_of: Option<String>,
    /// How many frames long it is, `1..=`[`MAX_ANIMATION_FRAMES`].
    ///
    /// Defaulted rather than required, because a mirror declares no timing of
    /// its own — it borrows its source's.
    #[serde(default = "default_frames")]
    pub frames: u32,
    /// How long each frame lasts, in milliseconds.
    #[serde(default = "default_frame_duration")]
    pub frame_duration_ms: u32,
    /// Whether it starts again when it ends.
    #[serde(default)]
    pub looping: bool,
    /// Pose values that hold for the **whole** animation.
    ///
    /// What is true of every frame of it: a walk seen from the side is
    /// `{ "view": "side" }`, and every layer with a side-on drawing says so
    /// once, in the `when` of one variant, rather than once per frame.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub pose: BTreeMap<String, Value>,
    /// Pose values set frame by frame, laid over [`Self::pose`].
    ///
    /// What changes *within* the animation: which leg is forward. An entry is
    /// the complete set of overrides for its frame rather than a delta on the
    /// entry before it, and it **holds** — before the first it is the first,
    /// after the last it is the last — because a drawing does not fade into
    /// another one.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub poses: Vec<PoseKey>,
    /// What moves, and when. A node with no track follows its parent.
    #[serde(default)]
    pub tracks: Vec<AnimationTrack>,
}

const fn default_frame_duration() -> u32 {
    DEFAULT_FRAME_DURATION_MS
}

const fn default_frames() -> u32 {
    1
}

impl Default for Animation {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            role: None,
            mirror_of: None,
            frames: 1,
            frame_duration_ms: DEFAULT_FRAME_DURATION_MS,
            looping: false,
            pose: BTreeMap::new(),
            poses: Vec::new(),
            tracks: Vec::new(),
        }
    }
}

impl Animation {
    /// How long one pass through it takes, in milliseconds.
    #[must_use]
    pub const fn duration_ms(&self) -> u32 {
        self.frames.saturating_mul(self.frame_duration_ms)
    }

    /// The track driving this node, if the animation has one.
    #[must_use]
    pub fn track(&self, node: &str) -> Option<&AnimationTrack> {
        self.tracks.iter().find(|track| track.node == node)
    }

    /// Where in the animation this time lands, measured in frames.
    ///
    /// A looping animation wraps; one that does not stops **inside** its last
    /// frame rather than one past the end, so a finished animation shows the
    /// pose it finished on.
    #[must_use]
    pub fn position_at(&self, time_ms: u32) -> f64 {
        let duration = self.duration_ms();
        if duration == 0 || self.frame_duration_ms == 0 {
            return 0.0;
        }
        let elapsed = if self.looping {
            time_ms % duration
        } else {
            time_ms.min(duration - 1)
        };
        f64::from(elapsed) / f64::from(self.frame_duration_ms)
    }

    /// The frame this time falls in, `0`-based.
    #[must_use]
    pub fn frame_at(&self, time_ms: u32) -> u32 {
        self.position_at(time_ms).floor() as u32
    }

    /// When a frame starts, in milliseconds — the inverse of [`Self::frame_at`].
    ///
    /// What a timeline scrubs to: clicking frame 3 has to mean a time, and the
    /// time it means is the beginning of that frame.
    #[must_use]
    pub const fn time_of(&self, frame: u32) -> u32 {
        frame.saturating_mul(self.frame_duration_ms)
    }

    /// `true` when this animation is another one seen the other way round.
    #[must_use]
    pub const fn is_mirror(&self) -> bool {
        self.mirror_of.is_some()
    }

    /// The pose in force at this time: [`Self::pose`] under [`Self::poses`].
    ///
    /// These are the values a layer's `when` conditions are tested against
    /// alongside the customisation, which is what lets one line of a variant
    /// answer a whole animation and four lines answer a walk cycle
    /// (`docs/adr/ADR-0025-characters-animate-by-hierarchy-and-offsets.md`).
    #[must_use]
    pub fn pose_at(&self, time_ms: u32) -> BTreeMap<String, Value> {
        let mut merged = self.pose.clone();
        if let Some(key) = self.pose_key_at(self.position_at(time_ms)) {
            merged.extend(
                key.values
                    .iter()
                    .map(|(id, value)| (id.clone(), value.clone())),
            );
        }
        merged
    }

    /// The pose entry in force at `position`, in frames.
    ///
    /// The last one at or before it, and failing that the first one written at
    /// all: a pose holds in both directions, the same way a hand-drawn sprite
    /// stays on screen until it is replaced.
    fn pose_key_at(&self, position: f64) -> Option<&PoseKey> {
        self.poses
            .iter()
            .filter(|key| f64::from(key.frame) <= position)
            .reduce(|best, key| if key.frame >= best.frame { key } else { best })
            .or_else(|| self.poses.iter().min_by_key(|key| key.frame))
    }

    /// Every node's **local** transform at this time.
    ///
    /// Local, not global: composing them down the tree needs the hierarchy,
    /// which is the definition's, not the animation's
    /// (`CharacterDefinition::resolve_at`).
    #[must_use]
    pub fn local_transforms(&self, time_ms: u32) -> BTreeMap<&str, Transform> {
        let position = self.position_at(time_ms);
        let wrap = self.looping.then(|| f64::from(self.frames));
        self.tracks
            .iter()
            .filter(|track| !track.keyframes.is_empty())
            .map(|track| (track.node.as_str(), track.transform_at(position, wrap)))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The breathing idle: four frames, looping, and one track that lifts the
    /// body two pixels and sets it back down.
    fn idle() -> Animation {
        serde_json::from_str(
            r#"{
                "id": "idle", "name": "Idle", "frames": 4,
                "frameDurationMs": 120, "looping": true,
                "tracks": [
                    { "node": "body", "keyframes": [
                        { "frame": 0, "offset": [0, 0] },
                        { "frame": 1, "offset": [0, -2] },
                        { "frame": 2, "offset": [0, 0] },
                        { "frame": 3, "offset": [0, 2] }
                    ] }
                ]
            }"#,
        )
        .expect("parse")
    }

    #[test]
    fn an_animation_parses_and_round_trips() {
        let animation = idle();
        assert_eq!(animation.frames, 4);
        assert_eq!(animation.frame_duration_ms, 120);
        assert!(animation.looping);
        assert_eq!(animation.duration_ms(), 480);

        let reparsed: Animation =
            serde_json::from_str(&serde_json::to_string(&animation).expect("serialise"))
                .expect("reparse");
        assert_eq!(animation, reparsed);
    }

    #[test]
    fn gameplay_roles_round_trip_and_group_hex_directions_left_or_right() {
        let animation: Animation =
            serde_json::from_str(r#"{ "id": "shuffle", "role": "moveLeft", "frames": 2 }"#)
                .expect("parse");
        assert_eq!(animation.role, Some(AnimationRole::MoveLeft));
        assert_eq!(
            AnimationRole::for_direction(HexDirection::NorthWest).fallback(),
            Some(AnimationRole::MoveLeft)
        );
        assert_eq!(
            AnimationRole::for_direction(HexDirection::SouthEast).fallback(),
            Some(AnimationRole::MoveRight)
        );
        assert_eq!(
            "moveNorthEast".parse::<AnimationRole>(),
            Ok(AnimationRole::MoveNorthEast)
        );
        assert!("walk".parse::<AnimationRole>().is_err());

        let json = serde_json::to_string(&animation).expect("serialise");
        assert!(json.contains(r#""role":"moveLeft""#));
    }

    /// The transform is flattened, so a keyframe is one readable line.
    #[test]
    fn a_keyframe_writes_its_offset_beside_its_frame() {
        let keyframe = Keyframe {
            frame: 3,
            transform: Transform::at(1, -2),
            interpolation: Interpolation::Step,
        };
        let json = serde_json::to_string(&keyframe).expect("serialise");
        assert_eq!(json, r#"{"frame":3,"offset":[1,-2]}"#);
    }

    #[test]
    fn a_file_that_names_no_duration_gets_the_default_one() {
        let animation: Animation =
            serde_json::from_str(r#"{ "id": "hurt", "frames": 2 }"#).expect("parse");
        assert_eq!(animation.frame_duration_ms, DEFAULT_FRAME_DURATION_MS);
        assert!(!animation.looping);
        assert!(animation.tracks.is_empty());
    }

    #[test]
    fn time_maps_onto_the_frame_it_falls_in() {
        let animation = idle();
        assert_eq!(animation.frame_at(0), 0);
        assert_eq!(animation.frame_at(119), 0);
        assert_eq!(animation.frame_at(120), 1);
        assert_eq!(animation.frame_at(359), 2);
        assert_eq!(animation.time_of(3), 360);
    }

    /// Past its length a looping animation comes back to the beginning, and
    /// one that does not loop stays on the pose it finished on.
    #[test]
    fn a_looping_animation_wraps_and_a_finished_one_holds_its_last_frame() {
        let animation = idle();
        assert_eq!(animation.frame_at(480), 0);
        assert_eq!(animation.frame_at(600), 1);
        assert_eq!(animation.frame_at(4_800), 0);

        let mut once = idle();
        once.looping = false;
        assert_eq!(once.frame_at(480), 3);
        assert_eq!(once.frame_at(100_000), 3);
        assert_eq!(once.local_transforms(100_000)["body"], Transform::at(0, 2));
    }

    #[test]
    fn each_frame_of_the_idle_holds_the_value_written_at_it() {
        let animation = idle();
        let body_at = |time| animation.local_transforms(time)["body"].offset;

        assert_eq!(body_at(0), PixelOffset::new(0, 0));
        assert_eq!(body_at(120), PixelOffset::new(0, -2));
        assert_eq!(body_at(240), PixelOffset::new(0, 0));
        assert_eq!(body_at(360), PixelOffset::new(0, 2));
        // And around again, unchanged.
        assert_eq!(body_at(480), PixelOffset::new(0, 0));
    }

    /// Step is the default, so a frame holds its value until the next one.
    #[test]
    fn a_step_track_holds_its_value_across_the_whole_frame() {
        let animation = idle();
        assert_eq!(
            animation.local_transforms(120).get("body"),
            animation.local_transforms(239).get("body"),
        );
    }

    #[test]
    fn a_linear_track_travels_between_its_keyframes() {
        let animation: Animation = serde_json::from_str(
            r#"{ "id": "rise", "frames": 2, "frameDurationMs": 100, "tracks": [
                { "node": "body", "keyframes": [
                    { "frame": 0, "offset": [0, 0], "interpolation": "linear" },
                    { "frame": 1, "offset": [0, -10] }
                ] } ] }"#,
        )
        .expect("parse");

        let body_at = |time| animation.local_transforms(time)["body"].offset.y();
        assert_eq!(body_at(0), 0);
        assert_eq!(body_at(50), -5);
        assert_eq!(body_at(100), -10);
        // Past the last keyframe it holds, and this animation does not loop.
        assert_eq!(body_at(199), -10);
    }

    /// A looping linear track travels back to its first value rather than
    /// snapping — otherwise every loop has a visible jolt in it.
    #[test]
    fn a_looping_linear_track_returns_to_its_first_keyframe() {
        let animation: Animation = serde_json::from_str(
            r#"{ "id": "bob", "frames": 2, "frameDurationMs": 100, "looping": true, "tracks": [
                { "node": "body", "keyframes": [
                    { "frame": 0, "offset": [0, 0], "interpolation": "linear" },
                    { "frame": 1, "offset": [0, -4], "interpolation": "linear" }
                ] } ] }"#,
        )
        .expect("parse");

        let body_at = |time| animation.local_transforms(time)["body"].offset.y();
        assert_eq!(body_at(100), -4);
        assert_eq!(body_at(150), -2);
        assert_eq!(body_at(200), 0);
    }

    /// A track that starts late holds its first value rather than snapping in
    /// from nowhere.
    #[test]
    fn a_track_holds_its_first_value_before_its_first_keyframe() {
        let animation: Animation = serde_json::from_str(
            r#"{ "id": "late", "frames": 4, "frameDurationMs": 100, "tracks": [
                { "node": "arm", "keyframes": [ { "frame": 2, "offset": [3, 0] } ] } ] }"#,
        )
        .expect("parse");
        assert_eq!(animation.local_transforms(0)["arm"], Transform::at(3, 0));
        assert_eq!(animation.local_transforms(300)["arm"], Transform::at(3, 0));
    }

    #[test]
    fn an_empty_track_yields_nothing_rather_than_an_identity() {
        let animation: Animation = serde_json::from_str(
            r#"{ "id": "empty", "frames": 2, "tracks": [ { "node": "arm" } ] }"#,
        )
        .expect("parse");
        assert!(animation.local_transforms(0).is_empty());
    }

    /// Same time, same data, same answer — every time.
    #[test]
    fn evaluation_is_deterministic() {
        let animation = idle();
        for time in [0_u32, 37, 120, 359, 480, 1_234, 99_999] {
            assert_eq!(
                animation.local_transforms(time),
                animation.local_transforms(time),
            );
        }
    }

    #[test]
    fn a_zero_length_animation_evaluates_rather_than_dividing_by_zero() {
        let animation = Animation {
            id: "broken".to_owned(),
            frames: 0,
            frame_duration_ms: 0,
            ..Animation::default()
        };
        assert_eq!(animation.duration_ms(), 0);
        assert_eq!(animation.frame_at(500), 0);
        assert!(animation.local_transforms(500).is_empty());
    }

    /// An animation redraws by setting pose values, not by naming a sprite —
    /// one line per frame, and every layer reads it.
    #[test]
    fn a_pose_is_set_for_the_whole_animation_and_again_per_frame() {
        let walk: Animation = serde_json::from_str(
            r#"{ "id": "walk", "frames": 4, "frameDurationMs": 100, "looping": true,
                 "pose": { "view": "side" },
                 "poses": [
                    { "frame": 0, "step": "contact" },
                    { "frame": 1, "step": "pass" },
                    { "frame": 2, "step": "contactBack" },
                    { "frame": 3, "step": "passBack" } ] }"#,
        )
        .expect("parse");

        let step_at = |time| walk.pose_at(time)["step"].as_str().map(str::to_owned);
        assert_eq!(step_at(0).as_deref(), Some("contact"));
        assert_eq!(step_at(100).as_deref(), Some("pass"));
        assert_eq!(step_at(250).as_deref(), Some("contactBack"));
        assert_eq!(step_at(300).as_deref(), Some("passBack"));
        // It loops with everything else.
        assert_eq!(step_at(400).as_deref(), Some("contact"));

        // The animation-wide value is in force at every one of them.
        for time in [0, 100, 200, 300, 999] {
            assert_eq!(walk.pose_at(time)["view"], serde_json::json!("side"));
        }
    }

    /// A pose entry holds until the next one: a frame that sets nothing is a
    /// frame that changed nothing, not a frame that cleared the pose.
    #[test]
    fn a_pose_holds_across_the_frames_that_set_nothing() {
        let animation: Animation = serde_json::from_str(
            r#"{ "id": "a", "frames": 4, "frameDurationMs": 100,
                 "poses": [ { "frame": 0, "step": "open" },
                            { "frame": 3, "step": "closed" } ] }"#,
        )
        .expect("parse");

        for time in [0, 100, 200] {
            assert_eq!(animation.pose_at(time)["step"], serde_json::json!("open"));
        }
        assert_eq!(animation.pose_at(300)["step"], serde_json::json!("closed"));
    }

    /// A pose that only starts at frame 2 is still in force at frame 0:
    /// holding backwards is what a first entry means.
    #[test]
    fn a_pose_holds_before_the_first_frame_that_sets_one() {
        let animation: Animation = serde_json::from_str(
            r#"{ "id": "a", "frames": 4, "poses": [ { "frame": 2, "step": "late" } ] }"#,
        )
        .expect("parse");
        assert_eq!(animation.pose_at(0)["step"], serde_json::json!("late"));
    }

    /// A frame's value wins over the animation's, which is what "laid over"
    /// means — and any JSON scalar works, not only strings.
    #[test]
    fn a_frame_overrides_the_animation_wide_pose() {
        let animation: Animation = serde_json::from_str(
            r#"{ "id": "a", "frames": 2, "frameDurationMs": 100,
                 "pose": { "view": "side", "airborne": false },
                 "poses": [ { "frame": 0, "airborne": false },
                            { "frame": 1, "airborne": true } ] }"#,
        )
        .expect("parse");

        assert_eq!(animation.pose_at(0)["airborne"], serde_json::json!(false));
        assert_eq!(animation.pose_at(100)["airborne"], serde_json::json!(true));
        assert_eq!(animation.pose_at(100)["view"], serde_json::json!("side"));
    }

    #[test]
    fn an_animation_that_sets_no_pose_has_none() {
        assert!(idle().pose_at(120).is_empty());
    }

    /// A pose entry is one readable line, frame and values side by side.
    #[test]
    fn a_pose_entry_writes_its_values_beside_its_frame() {
        let animation: Animation = serde_json::from_str(
            r#"{ "id": "a", "frames": 2, "poses": [ { "frame": 1, "step": "pass" } ] }"#,
        )
        .expect("parse");
        let json = serde_json::to_string(&animation.poses[0]).expect("serialise");
        assert_eq!(json, r#"{"frame":1,"step":"pass"}"#);
    }

    /// A mirror carries nothing but the id it reflects; the file says so and
    /// nothing else.
    #[test]
    fn a_mirror_parses_with_no_timing_of_its_own() {
        let mirror: Animation = serde_json::from_str(
            r#"{ "id": "walking_right", "name": "Walking right",
                 "mirrorOf": "walking_left" }"#,
        )
        .expect("parse");

        assert!(mirror.is_mirror());
        assert_eq!(mirror.mirror_of.as_deref(), Some("walking_left"));
        assert!(mirror.tracks.is_empty());
        assert!(!idle().is_mirror());

        let json = serde_json::to_string(&mirror).expect("serialise");
        assert_eq!(
            serde_json::from_str::<Animation>(&json).expect("reparse"),
            mirror
        );
    }

    #[test]
    fn offsets_compose_by_adding() {
        let parent = Transform::at(0, -2);
        let child = Transform::at(1, 0);
        assert_eq!(child.compose(parent), Transform::at(1, -2));
        assert!(Transform::identity().is_identity());
    }
}
