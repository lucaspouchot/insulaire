//! What a content kind *is*, once.
//!
//! "Content kind" is the concept this engine repeats most: a tile set, a world,
//! a character, a decoration, an object, a title screen, a settings
//! declaration, a character creation, a project manifest. Every one of them is
//! authored as a JSON file, parsed into a definition, checked by a validator in
//! `insulaire_world`, and kept under a stable id until something resets the
//! content. Only the definition and the validator differ.
//!
//! That shared half used to be written out per kind — parse, validate, refuse,
//! insert, read back, list, clear — which is why adding two kinds once cost a
//! thousand lines before a single rule was written. Here it is written once,
//! over a [`ContentKind`], and a kind declares what makes it that kind:
//!
//! ```text
//! WHAT             what an error message calls it
//! Definition       what its file parses into
//! Shelf            whether a project holds many of them or one
//! validate         the rules, given whatever else is loaded
//! referenced_keys  the locale keys it names, if it names any
//! ```
//!
//! Everything else — [`ContentRegistry::load`], [`ContentRegistry::get`],
//! [`ContentRegistry::ids`], [`ContentRegistry::only`], the error strings, the
//! refusal of an invalid file — is this module's, for every kind at once.
//!
//! `insulaire_world` keeps every rule: this module moves no validation, it
//! removes the threading around it (`docs/adr/ADR-0012-shared-content-validation.md`,
//! `docs/adr/ADR-0010-engine-api.md`).
//!
//! # What is not a kind
//!
//! A locale file is not one. It has no id of its own, it is keyed by language
//! *and* namespace, several files merge into one bundle, and a key defined
//! twice is a parse error rather than a validation issue
//! (`docs/adr/ADR-0020-localised-content-keys.md`). Forcing it through
//! [`ContentKind`] would cost more interface than it saves, so
//! [`ContentRegistry`] keeps the locale door by hand.

use std::collections::BTreeMap;

use serde::de::DeserializeOwned;

use insulaire_world::{validate_referenced_keys, LocaleBundle, ValidationReport};

use crate::error::EngineError;
use crate::registry::ContentRegistry;

/// Where a kind's definitions live between a load and a reset.
///
/// Two shapes only, and the difference is a fact about the *content* rather
/// than about the storage: a project paints with many tile sets and opens on
/// one title screen. Loading is the same for both, which is all this trait
/// exists to say; reading them is not, which is why [`Many`] and [`One`] have
/// their own accessors instead of a lowest common denominator.
pub trait Shelf<D>: Default {
    /// Takes a definition the registry has accepted.
    ///
    /// A [`Many`] files it under `id`, replacing whatever answered to that id
    /// before; a [`One`] replaces what it held whatever the id is. Both need
    /// [`Validated`], which only [`ContentRegistry::load`] can produce — so
    /// content that has not been through its kind's validator cannot be
    /// registered from outside this crate at all, rather than merely by
    /// convention.
    fn put(&mut self, id: String, definition: D, validated: Validated);

    /// Forgets everything held.
    fn clear(&mut self);
}

/// Proof that a definition passed its kind's validator.
///
/// The registry used to keep its maps private, which is what made
/// [`ContentRegistry::load`] the only way in: "a world is registered only if it
/// has no errors" (`docs/adr/ADR-0012-shared-content-validation.md`) held
/// because there was no other door. Making the storage generic over a public
/// trait opened one, and this closes it again — the field is private, so no
/// caller outside this crate can spell the argument [`Shelf::put`] demands.
#[derive(Debug, Clone, Copy)]
pub struct Validated(());

/// Definitions kept by id — a kind a project may hold many of.
#[derive(Debug, Clone)]
pub struct Many<D>(BTreeMap<String, D>);

impl<D> Default for Many<D> {
    fn default() -> Self {
        Self(BTreeMap::new())
    }
}

impl<D> Shelf<D> for Many<D> {
    fn put(&mut self, id: String, definition: D, _validated: Validated) {
        self.0.insert(id, definition);
    }

    fn clear(&mut self) {
        self.0.clear();
    }
}

impl<D> Many<D> {
    /// The definition registered under `id`.
    pub fn get(&self, id: &str) -> Option<&D> {
        self.0.get(id)
    }

    /// Every id held, sorted.
    pub fn ids(&self) -> Vec<String> {
        self.0.keys().cloned().collect()
    }

    /// Every definition held, in id order.
    pub fn values(&self) -> impl Iterator<Item = &D> {
        self.0.values()
    }
}

/// At most one definition — a kind a project declares once, or not at all.
///
/// A second file replaces the first rather than accumulating: a project opens
/// on a single menu and ships a single settings declaration, so "the one that
/// is loaded" is the only question a caller can ask.
#[derive(Debug, Clone)]
pub struct One<D>(Option<D>);

impl<D> Default for One<D> {
    fn default() -> Self {
        Self(None)
    }
}

impl<D> Shelf<D> for One<D> {
    fn put(&mut self, _id: String, definition: D, _validated: Validated) {
        self.0 = Some(definition);
    }

    fn clear(&mut self) {
        self.0 = None;
    }
}

impl<D> One<D> {
    /// The registered definition, whatever id it carries.
    pub const fn get(&self) -> Option<&D> {
        self.0.as_ref()
    }
}

/// One kind of authored content, declared once.
///
/// Implementations are generated by `content_kinds!` in
/// [`crate::registry`], which is the list this engine's kinds are declared in.
pub trait ContentKind: Sized + 'static {
    /// What one of this kind's files parses into.
    type Definition: DeserializeOwned;

    /// Where the registry keeps them.
    type Shelf: Shelf<Self::Definition>;

    /// What an error message calls this kind: `"tile set"`, `"character"`.
    ///
    /// One string serves the parse error, the refusal of an invalid file and
    /// the "no such content" error, so the three cannot drift apart.
    const WHAT: &'static str;

    /// The stable id a definition is registered under.
    fn id(definition: &Self::Definition) -> &str;

    /// The registry's shelf for this kind.
    ///
    /// Reaching it gives no way to register anything: [`Shelf::put`] wants a
    /// [`Validated`], which only [`ContentRegistry::load`] can make.
    fn shelf_mut(registry: &mut ContentRegistry) -> &mut Self::Shelf;

    /// The rules, given whatever else the registry currently holds.
    ///
    /// Every implementation of this delegates to `insulaire_world`: a world is
    /// checked against its tile set, a creation against the loaded characters,
    /// a project against everything. Nothing validates here.
    fn validate(registry: &ContentRegistry, definition: &Self::Definition) -> ValidationReport;

    /// The locale keys this definition names, with the path each came from.
    ///
    /// Empty for a kind that shows no text of its own. What is checked, and
    /// when, is [`ContentRegistry::key_report`]'s
    /// (`docs/adr/ADR-0020-localised-content-keys.md`).
    fn referenced_keys(definition: &Self::Definition) -> Vec<(String, &str)> {
        let _ = definition;
        Vec::new()
    }
}

/// A kind a project may hold many of, each answering for its own id.
pub trait Keyed: ContentKind {
    /// The shelf, as the many-definition shape it is.
    fn many(registry: &ContentRegistry) -> &Many<Self::Definition>;
}

/// A kind a project holds at most one of.
pub trait Sole: ContentKind {
    /// The shelf, as the single-definition shape it is.
    fn one(registry: &ContentRegistry) -> &One<Self::Definition>;
}

impl ContentRegistry {
    /// Reads one authored file, without validating or registering it.
    ///
    /// # Errors
    ///
    /// [`EngineError::Parse`] when the JSON does not match the definition.
    pub fn parse<K: ContentKind>(json: &str) -> Result<K::Definition, EngineError> {
        serde_json::from_str(json).map_err(|source| EngineError::Parse {
            what: K::WHAT.to_owned(),
            message: source.to_string(),
        })
    }

    /// Parses, validates and registers one authored file.
    ///
    /// A file with an error in it is refused rather than registered, which is
    /// what makes "the editor exported it, therefore the runtime can load it" a
    /// guarantee rather than a hope. Warnings do not prevent registration, and
    /// come back with the id so a host can show them.
    ///
    /// # Errors
    ///
    /// [`EngineError::Parse`] when the JSON is malformed, or
    /// [`EngineError::Invalid`] when the definition fails its validator.
    pub fn load<K: ContentKind>(
        &mut self,
        json: &str,
    ) -> Result<(String, ValidationReport), EngineError> {
        let definition = Self::parse::<K>(json)?;

        let report = K::validate(self, &definition);
        if !report.valid {
            return Err(EngineError::Invalid {
                what: format!("{} `{}`", K::WHAT, K::id(&definition)),
                report: Box::new(report),
            });
        }

        let id = K::id(&definition).to_owned();
        K::shelf_mut(self).put(id.clone(), definition, Validated(()));
        Ok((id, report))
    }

    /// Validates one authored file **without** registering it, keys included.
    ///
    /// This is what an editor calls before writing: the same validator the
    /// runtime loads with, so a file the editor accepts is a file the runtime
    /// accepts (`docs/adr/ADR-0012-shared-content-validation.md`), plus the
    /// locale keys it names — an editor wants both answers at once.
    ///
    /// # Errors
    ///
    /// [`EngineError::Parse`] when the JSON is malformed. A file that parses
    /// but is unusable produces an invalid report rather than an error.
    pub fn validate_json<K: ContentKind>(
        &self,
        json: &str,
    ) -> Result<ValidationReport, EngineError> {
        let definition = Self::parse::<K>(json)?;
        Ok(K::validate(self, &definition).merge(self.key_report::<K>(&definition)))
    }

    /// Whether the keys one definition names resolve in some loaded language.
    ///
    /// With no language loaded there is nothing to check against, and the
    /// manifest's own `locale.unloadedLanguage` is the issue to report then —
    /// not a key error against every label
    /// (`docs/adr/ADR-0020-localised-content-keys.md`).
    #[must_use]
    pub fn key_report<K: ContentKind>(&self, definition: &K::Definition) -> ValidationReport {
        let bundles: Vec<&LocaleBundle> = self.locales().collect();
        if bundles.is_empty() {
            return ValidationReport::clean();
        }
        let keys = K::referenced_keys(definition);
        validate_referenced_keys(
            keys.iter().map(|(path, key)| (path.as_str(), *key)),
            &bundles,
        )
    }

    /// A registered definition of a kind held by id.
    #[must_use]
    pub fn get<K: Keyed>(&self, id: &str) -> Option<&K::Definition> {
        K::many(self).get(id)
    }

    /// The ids of every registered definition of a kind, sorted.
    #[must_use]
    pub fn ids<K: Keyed>(&self) -> Vec<String> {
        K::many(self).ids()
    }

    /// Every registered definition of a kind, in id order.
    pub fn all<K: Keyed>(&self) -> impl Iterator<Item = &K::Definition> {
        K::many(self).values()
    }

    /// The registered definition of a kind a project holds one of.
    #[must_use]
    pub fn only<K: Sole>(&self) -> Option<&K::Definition> {
        K::one(self).get()
    }
}

/// Declares the registry's storage and its content kinds in one list.
///
/// The trait above says what a kind *does*; this says which kinds there are and
/// where each one lives. Both halves are needed and neither is boilerplate on
/// its own — a row states the four facts that make a kind that kind, and the
/// struct field, the [`Shelf`] wiring and the reset that used to be written by
/// hand for each are generated from it.
///
/// The rows are grouped by shelf shape, because that is what decides how a
/// caller reads the kind back: `many { … }` gets [`ContentRegistry::get`] and
/// [`ContentRegistry::ids`], `one { … }` gets [`ContentRegistry::only`].
macro_rules! content_kinds {
    (
        $(#[$registry_doc:meta])*
        pub struct $registry:ident {
            $(
                $(#[$field_doc:meta])*
                $field:ident: $field_type:ty,
            )*
        }

        many {
            $(
                $(#[$many_doc:meta])*
                $many:ident {
                    what: $many_what:literal,
                    of: $many_definition:ty,
                    at: $many_slot:ident,
                    validate: |$many_registry:pat_param, $many_value:pat_param| $many_rules:expr,
                    $(keys: |$many_keyed:pat_param| $many_keys:expr,)?
                }
            )*
        }

        one {
            $(
                $(#[$one_doc:meta])*
                $one:ident {
                    what: $one_what:literal,
                    of: $one_definition:ty,
                    at: $one_slot:ident,
                    validate: |$one_registry:pat_param, $one_value:pat_param| $one_rules:expr,
                    $(keys: |$one_keyed:pat_param| $one_keys:expr,)?
                }
            )*
        }
    ) => {
        $(#[$registry_doc])*
        #[derive(Debug, Clone, Default)]
        pub struct $registry {
            $(
                $(#[$field_doc])*
                $field: $field_type,
            )*
            $($many_slot: $crate::kind::Many<$many_definition>,)*
            $($one_slot: $crate::kind::One<$one_definition>,)*
        }

        impl $registry {
            /// Forgets every registered definition, of every kind.
            fn clear_kinds(&mut self) {
                $($crate::kind::Shelf::clear(&mut self.$many_slot);)*
                $($crate::kind::Shelf::clear(&mut self.$one_slot);)*
            }
        }

        $(
            $(#[$many_doc])*
            #[derive(Debug, Clone, Copy, PartialEq, Eq)]
            pub struct $many;

            impl $crate::kind::ContentKind for $many {
                type Definition = $many_definition;
                type Shelf = $crate::kind::Many<$many_definition>;
                const WHAT: &'static str = $many_what;

                fn id(definition: &Self::Definition) -> &str {
                    &definition.id
                }

                fn shelf_mut(registry: &mut $registry) -> &mut Self::Shelf {
                    &mut registry.$many_slot
                }

                fn validate(
                    registry: &$registry,
                    definition: &Self::Definition,
                ) -> ValidationReport {
                    let $many_registry = registry;
                    let $many_value = definition;
                    $many_rules
                }

                $(
                    fn referenced_keys(definition: &Self::Definition) -> Vec<(String, &str)> {
                        let $many_keyed = definition;
                        $many_keys
                    }
                )?
            }

            impl $crate::kind::Keyed for $many {
                fn many(registry: &$registry) -> &$crate::kind::Many<$many_definition> {
                    &registry.$many_slot
                }
            }
        )*

        $(
            $(#[$one_doc])*
            #[derive(Debug, Clone, Copy, PartialEq, Eq)]
            pub struct $one;

            impl $crate::kind::ContentKind for $one {
                type Definition = $one_definition;
                type Shelf = $crate::kind::One<$one_definition>;
                const WHAT: &'static str = $one_what;

                fn id(definition: &Self::Definition) -> &str {
                    &definition.id
                }

                fn shelf_mut(registry: &mut $registry) -> &mut Self::Shelf {
                    &mut registry.$one_slot
                }

                fn validate(
                    registry: &$registry,
                    definition: &Self::Definition,
                ) -> ValidationReport {
                    let $one_registry = registry;
                    let $one_value = definition;
                    $one_rules
                }

                $(
                    fn referenced_keys(definition: &Self::Definition) -> Vec<(String, &str)> {
                        let $one_keyed = definition;
                        $one_keys
                    }
                )?
            }

            impl $crate::kind::Sole for $one {
                fn one(registry: &$registry) -> &$crate::kind::One<$one_definition> {
                    &registry.$one_slot
                }
            }
        )*
    };
}

pub(crate) use content_kinds;

#[cfg(test)]
mod tests {
    use super::{Many, One, Shelf, Validated};

    /// In-crate, so the tests may make one; outside, `put` is unreachable.
    const VALIDATED: Validated = Validated(());

    #[test]
    fn a_many_shelf_answers_by_id_in_id_order() {
        let mut shelf = Many::default();
        shelf.put("second".to_owned(), 2, VALIDATED);
        shelf.put("first".to_owned(), 1, VALIDATED);

        assert_eq!(shelf.get("first"), Some(&1));
        assert_eq!(shelf.get("absent"), None);
        assert_eq!(shelf.ids(), vec!["first", "second"]);
        assert_eq!(shelf.values().copied().collect::<Vec<_>>(), vec![1, 2]);

        shelf.put("first".to_owned(), 10, VALIDATED);
        assert_eq!(shelf.get("first"), Some(&10), "a reload replaces");
        assert_eq!(shelf.ids().len(), 2);

        shelf.clear();
        assert!(shelf.ids().is_empty());
    }

    /// The id is *not* what a `one` shelf is read by: a caller asks for "the
    /// one that is loaded", so a second file replaces the first whatever it is
    /// called.
    #[test]
    fn a_one_shelf_keeps_the_last_file_whatever_its_id() {
        let mut shelf = One::default();
        assert_eq!(shelf.get(), None);

        shelf.put("first".to_owned(), 1, VALIDATED);
        shelf.put("second".to_owned(), 2, VALIDATED);
        assert_eq!(shelf.get(), Some(&2));

        shelf.clear();
        assert_eq!(shelf.get(), None);
    }
}
