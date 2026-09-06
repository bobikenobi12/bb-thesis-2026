// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"os"
	"regexp"
	"sort"
	"strings"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/charmbracelet/huh"
)

// Which member / team / role / grant / provider? — the ONE resolver behind every command in this
// group that acts on a single thing.
//
// All five used to take the id as a REQUIRED positional. The only way to obtain one was to run the
// group's `list` first and copy a uuid across by eye; `organizations.mdx` and `access.mdx` both
// shipped examples built out of made-up ids (`mbr_123`, `team_123`, `3f1c…`) precisely because
// there is nothing else a page can print for a token the reader has to fetch for themselves. That
// copied token is a HANDOFF, and removing the handoffs is what this programme is for.
//
// So the id now has three sources, and they are three renderings of ONE spec (orgFields):
//
//	positional    alethia teams delete 8f3c…       an id you already have
//	--<selector>  alethia teams delete --name web  the human name — works under --no-input
//	the picker    alethia teams delete             a list to choose from, on a terminal
//
// The selector flag is what makes `--no-input` a complete contract rather than a dead end, and the
// refusal a scripted caller gets NAMES it rather than saying "interactive input required".

// orgRef is a resolved entity: its id, plus the one-line summary of how it was found.
//
// Summary is EMPTY when the id came from the command line, and set when the CLI chose. Callers use
// that difference: a destructive command that resolved its own target must say what the target was,
// because "Remove this member?" is not a question a reader can answer about an id they never saw.
type orgRef struct {
	ID      string
	Summary string
}

// announceResolvedChoice tells the reader which entity the CLI chose, on STDERR.
//
// Stderr and not stdout, because these commands are piped: a `-o json` document must not gain a
// prose line, and a diagnostic about which team was picked is not part of the payload. Nothing is
// announced when the caller named the thing — describing an id back at the person who typed it is
// noise, and it is the resolved case that needs saying.
//
// The jobs group has the same rule in announceResolvedJob, typed on its own jobRef. They are not
// one function yet because that would mean editing another lane's file; this signature is the
// general one, and #3661's shared kit is where they converge.
func announceResolvedChoice(summary, verb string) {
	if summary == "" {
		return
	}
	fmt.Fprintln(os.Stderr, ui.MutedStyle.Render(ui.SymbolPoint+" "+verb+" "+summary))
}

// orgChoice is one option: the id the command needs, the label a person reads, and the keys a
// selector flag may name it by.
//
// Keys are matched case-insensitively and are never ids — the id is already the positional. An
// empty key is dropped rather than matched, so a member with no name cannot be selected by passing
// an empty --email.
type orgChoice struct {
	ID    string
	Label string
	Keys  []string
}

// matches reports whether v names this choice.
func (c orgChoice) matches(v string) bool {
	for _, k := range c.Keys {
		if k != "" && strings.EqualFold(k, v) {
			return true
		}
	}
	return false
}

// orgPickSpec is the "which one?" wording for a single noun. One value per command, built from the
// orgField so the refusal, the picker and the docs cannot disagree.
type orgPickSpec struct {
	// Field is the spec entry this resolves. Its Title, Description and Selector are the picker's
	// title, the picker's description, and the flag the refusal names.
	Field orgField
	// Noun is the singular thing, for error prose: "team".
	Noun string
	// ListCmd is what to run to see the candidates: "alethia teams list".
	ListCmd string
	// Empty is the whole sentence for "there is nothing to pick", because "no teams" and "no
	// custom roles — the four built-in templates cannot be deleted" need different next steps.
	Empty string
}

// selectorFlag renders the spec's selector as it is typed: `--name`.
func (s orgPickSpec) selectorFlag() string { return "--" + s.Field.Selector }

// refuse builds the message for "nothing was named and nothing may be prompted".
//
// The flag is read FROM THE SPEC. A hand-typed list here would be another rendering of the spec
// that nothing keeps in step, and the reader of this message is exactly the person who cannot
// afford to be told about a flag that no longer exists.
func (s orgPickSpec) refuse() error {
	// The positional's placeholder is spelled out, not merely described. "pass the grant id" reads
	// as advice; `[grant_id]` is the thing to type, and it is the token the docs table carries — so
	// the message, the table and the command's own Use are one string, checked by
	// TestHygCliOrgForm_ScriptedRefusalNamesWhatToPass.
	if s.Field.Selector == "" {
		return fmt.Errorf(
			"no %s given, and interactive prompts are disabled (--no-input, or stdin is not a terminal): "+
				"pass the %s id %s — `%s` lists them",
			s.Noun, s.Noun, s.Field.Arg, s.ListCmd)
	}
	return fmt.Errorf(
		"no %s given, and interactive prompts are disabled (--no-input, or stdin is not a terminal): "+
			"pass the %s id %s, or %s to name it — `%s` lists them",
		s.Noun, s.Noun, s.Field.Arg, s.selectorFlag(), s.ListCmd)
}

// orgFieldToken renders how a field is typed: `--role`, or the positional `[email]`.
func orgFieldToken(f orgField) string {
	if f.Flag != "" {
		return "--" + f.Flag
	}
	return f.Arg
}

// refuseNoForm is the refusal when a form is the only remaining source for a value and no form can
// be shown.
//
// It NAMES what to pass, from the spec. "interactive input required but prompts are disabled" — the
// package's generic answer — tells a scripted caller that they are stuck without telling them how
// to become unstuck, and the flags it would have named are exactly the ones a reader cannot guess.
func refuseNoForm(fields ...orgField) error {
	tokens := make([]string, len(fields))
	for i, f := range fields {
		tokens[i] = orgFieldToken(f)
	}
	return fmt.Errorf(
		"interactive prompts are unavailable (--no-input, or stdin is not a terminal, "+
			"or the stream a prompt draws on is redirected): pass %s",
		strings.Join(tokens, " and "))
}

// resolveOrgChoice answers "which one" from the positional id, the selector flag, or the picker.
//
// The candidate list is fetched LAZILY: a caller who already has an id pays for no round trip, and
// a caller who passes both is told so before anything is fetched.
func resolveOrgChoice(spec orgPickSpec, id, selector string, list func() ([]orgChoice, error)) (orgRef, error) {
	id, selector = strings.TrimSpace(id), strings.TrimSpace(selector)

	if id != "" && selector != "" {
		// Silently preferring one would be the worse answer: `teams delete <id> --name other` would
		// delete the team whose id was given while appearing to have named a different one.
		return orgRef{}, fmt.Errorf("pass a %s id or %s, not both (%q and %q were given)",
			spec.Noun, spec.selectorFlag(), id, selector)
	}
	if id != "" {
		return orgRef{ID: id}, nil
	}
	if selector == "" {
		if err := requireInteractiveForm(); err != nil {
			return orgRef{}, spec.refuse()
		}
	}

	choices, err := list()
	if err != nil {
		return orgRef{}, err
	}
	if len(choices) == 0 {
		return orgRef{}, fmt.Errorf("%s", spec.Empty)
	}

	if selector != "" {
		for _, c := range choices {
			if c.matches(selector) {
				return orgRef{ID: c.ID, Summary: c.Label}, nil
			}
		}
		return orgRef{}, fmt.Errorf("no %s named %q (have: %s)", spec.Noun, selector, orgChoiceKeys(choices))
	}
	return pickOrgChoice(spec, choices)
}

// orgChoiceKeys renders every name a selector could have been given, for the "no such thing" error.
// Ids are deliberately absent: they are what the caller was trying to avoid.
func orgChoiceKeys(choices []orgChoice) string {
	var keys []string
	for _, c := range choices {
		for _, k := range c.Keys {
			if k != "" {
				keys = append(keys, k)
			}
		}
	}
	// Through ui.OrDash rather than returning the sentinel: a func in cmd/ that RETURNS
	// ui.SymbolDash is a render helper by shape, whichever name it carries, and
	// hyg_cli_render_test.go correctly said so about the first cut of this line.
	return ui.OrDash(strings.Join(keys, ", "))
}

// pickOrgChoice shows the interactive picker over already-fetched candidates.
//
// The option VALUE is the INDEX rather than the id, so the answer needs no lookup and there is no
// "the picker returned something I do not recognise" branch to write, test, or get wrong. huh can
// only write back one of the values it was given, and every index it was given is in range.
func pickOrgChoice(spec orgPickSpec, choices []orgChoice) (orgRef, error) {
	options := make([]huh.Option[int], len(choices))
	for i, c := range choices {
		options[i] = huh.NewOption(c.Label, i)
	}
	chosen := 0
	if err := runHuhForm(
		huh.NewGroup(
			huh.NewSelect[int]().
				Title(spec.Field.Title).
				Description(spec.Field.Description).
				Options(options...).
				Value(&chosen),
		),
	); err != nil {
		return orgRef{}, err
	}
	return orgRef{ID: choices[chosen].ID, Summary: choices[chosen].Label}, nil
}

// ── the candidate lists ─────────────────────────────────────────────────────────────────────────

// memberLister, teamLister, roleLister, grantLister and ssoLister are the slices of the API client
// each resolver needs — small enough that the resolution logic is unit-testable against a fake, and
// each satisfied by the concrete *api.Client.
type memberLister interface {
	ListMembers(orgID string) ([]api.Member, error)
}

type teamLister interface {
	ListTeams(orgID string) ([]api.Team, error)
}

type roleLister interface {
	ListRoles() ([]api.Role, error)
}

type grantLister interface {
	ListGrants() ([]api.Grant, error)
}

type ssoLister interface {
	ListSsoProviders() ([]api.SsoProvider, error)
}

// memberLabel renders one member as a single line: "Ada Lovelace · ada@example.com · owner · active".
func memberLabel(m api.Member) string {
	name := m.Name
	if name == "" {
		name = ui.SymbolDash
	}
	sep := " " + ui.SymbolBullet + " "
	return strings.Join([]string{name, m.Email, m.Role, m.Status}, sep)
}

// memberChoices lists the org's members, addressable by email.
//
// The id is the MEMBER id, which is what `DELETE /orgs/:id/members/:memberId` takes. It is NOT the
// user id `grants add --principal` wants — the same person carries two ids, which is exactly what
// an opaque positional hides and why grantPrincipalChoices below is a separate list.
func memberChoices(c memberLister, orgID string) func() ([]orgChoice, error) {
	return func() ([]orgChoice, error) {
		members, err := c.ListMembers(orgID)
		if err != nil {
			return nil, fmt.Errorf("failed to list members: %w", err)
		}
		out := make([]orgChoice, len(members))
		for i, m := range members {
			out[i] = orgChoice{ID: m.ID, Label: memberLabel(m), Keys: []string{m.Email}}
		}
		return out, nil
	}
}

// teamLabel renders one team as "platform · 4 members".
func teamLabel(t api.Team) string {
	unit := "members"
	if t.MemberCount == 1 {
		unit = "member"
	}
	return fmt.Sprintf("%s %s %d %s", t.Name, ui.SymbolBullet, t.MemberCount, unit)
}

// teamChoices lists the org's teams, addressable by name.
func teamChoices(c teamLister, orgID string) func() ([]orgChoice, error) {
	return func() ([]orgChoice, error) {
		teams, err := c.ListTeams(orgID)
		if err != nil {
			return nil, fmt.Errorf("failed to list teams: %w", err)
		}
		out := make([]orgChoice, len(teams))
		for i, t := range teams {
			out[i] = orgChoice{ID: t.ID, Label: teamLabel(t), Keys: []string{t.Name}}
		}
		return out, nil
	}
}

// roleLabel renders one role as "deployers · 3 permissions" (built-ins carry the brand marker).
func roleLabel(r api.Role) string {
	unit := "permissions"
	if len(r.PermissionKeys) == 1 {
		unit = "permission"
	}
	label := fmt.Sprintf("%s %s %d %s", r.Name, ui.SymbolBullet, len(r.PermissionKeys), unit)
	if r.IsBuiltin {
		label += ui.DefaultBadge()
	}
	return label
}

// deletableRoleChoices lists only the roles that CAN be deleted — the custom ones.
//
// `DELETE /api/cli/roles/:id` filters on `is_builtin = false`, so naming a built-in template
// deletes nothing and still answers `{ok: true}`: `alethia roles delete owner` printed
// "Role deleted" and changed nothing. Withholding a built-in from the picker and refusing it by
// name is the "provable subset" rule the programme states — the CLI may skip only what the server
// would CERTAINLY refuse, and a template it is structurally incapable of deleting qualifies.
func deletableRoleChoices(c roleLister) func() ([]orgChoice, error) {
	return func() ([]orgChoice, error) {
		roles, err := c.ListRoles()
		if err != nil {
			return nil, fmt.Errorf("failed to list roles: %w", err)
		}
		var out []orgChoice
		for _, r := range roles {
			if r.IsBuiltin {
				continue
			}
			out = append(out, orgChoice{ID: r.ID, Label: roleLabel(r), Keys: []string{r.Name}})
		}
		return out, nil
	}
}

// bindableRoleChoices lists every role a grant may bind — built-in templates included, because
// binding the `viewer` template to a team is the ordinary case.
func bindableRoleChoices(c roleLister) func() ([]orgChoice, error) {
	return func() ([]orgChoice, error) {
		roles, err := c.ListRoles()
		if err != nil {
			return nil, fmt.Errorf("failed to list roles: %w", err)
		}
		out := make([]orgChoice, len(roles))
		for i, r := range roles {
			out[i] = orgChoice{ID: r.ID, Label: roleLabel(r), Keys: []string{r.Name}}
		}
		return out, nil
	}
}

// grantLabel renders one grant as "allow · project:deploy · project (a1b2…) · team 7f3a…".
func grantLabel(g api.Grant) string {
	bound := g.PermissionKey
	if bound == "" {
		bound = g.Role
	}
	if bound == "" {
		bound = ui.SymbolDash
	}
	sep := " " + ui.SymbolBullet + " "
	return strings.Join([]string{
		g.Effect, bound, grantScope(g), g.PrincipalType + " " + ui.TruncID(g.PrincipalID),
	}, sep)
}

// grantChoices lists the org's grants. There is no selector: a grant has no name — it IS the
// binding — so the picker is the only way to name one without its id.
func grantChoices(c grantLister) func() ([]orgChoice, error) {
	return func() ([]orgChoice, error) {
		grants, err := c.ListGrants()
		if err != nil {
			return nil, fmt.Errorf("failed to list grants: %w", err)
		}
		out := make([]orgChoice, len(grants))
		for i, g := range grants {
			out[i] = orgChoice{ID: g.ID, Label: grantLabel(g)}
		}
		return out, nil
	}
}

// ssoLabel renders one provider as "oidc · example.com · https://idp.example.com".
func ssoLabel(p api.SsoProvider) string {
	sep := " " + ui.SymbolBullet + " "
	return strings.Join([]string{p.ProviderType, ui.OrDash(p.Domain), ui.OrDash(p.Issuer)}, sep)
}

// ssoChoices lists the org's SSO providers, addressable by their email domain.
func ssoChoices(c ssoLister) func() ([]orgChoice, error) {
	return func() ([]orgChoice, error) {
		providers, err := c.ListSsoProviders()
		if err != nil {
			return nil, fmt.Errorf("failed to list SSO providers: %w", err)
		}
		out := make([]orgChoice, len(providers))
		for i, p := range providers {
			out[i] = orgChoice{ID: p.ID, Label: ssoLabel(p), Keys: []string{p.Domain}}
		}
		return out, nil
	}
}

// ── the pick specs ──────────────────────────────────────────────────────────────────────────────

// memberPickSpec, teamPickSpec, deletableRolePickSpec, grantPickSpec and ssoPickSpec are built from
// orgFields, so a title, a description or a selector changed there reaches the picker and the
// refusal without a second edit.
var (
	memberPickSpec = orgPickSpec{
		Field:   mustOrgField("alethia members remove", orgFieldKeyMember),
		Noun:    "member",
		ListCmd: "alethia members list",
		Empty:   "this organization has no members to remove",
	}
	teamPickSpec = orgPickSpec{
		Field:   mustOrgField("alethia teams delete", orgFieldKeyTeam),
		Noun:    "team",
		ListCmd: "alethia teams list",
		Empty:   "this organization has no teams",
	}
	deletableRolePickSpec = orgPickSpec{
		Field:   mustOrgField("alethia roles delete", orgFieldKeyRole),
		Noun:    "custom role",
		ListCmd: "alethia roles list",
		Empty: "this organization has no custom roles — the four built-in templates " +
			"(owner, admin, operator, viewer) cannot be deleted",
	}
	grantPickSpec = orgPickSpec{
		Field:   mustOrgField("alethia grants remove", orgFieldKeyGrant),
		Noun:    "grant",
		ListCmd: "alethia grants list",
		Empty:   "this organization has no access grants",
	}
	ssoPickSpec = orgPickSpec{
		Field:   mustOrgField("alethia sso get", orgFieldKeyProvider),
		Noun:    "SSO provider",
		ListCmd: "alethia sso list",
		Empty:   "this organization has no SSO providers configured",
	}
	grantRolePickSpec = orgPickSpec{
		Field:   mustOrgField("alethia grants add", orgFieldKeyBoundRole),
		Noun:    "role",
		ListCmd: "alethia roles list",
		Empty:   "this organization has no roles to bind",
	}
	grantPrincipalPickSpec = orgPickSpec{
		Field:   mustOrgField("alethia grants add", orgFieldKeyPrincipal),
		Noun:    "principal",
		ListCmd: "alethia members list",
		Empty:   "this organization has no members or teams to grant access to",
	}
)

// ── the closed sets, mirrored from the route ────────────────────────────────────────────────────

// grantPrincipalTypes and grantEffects mirror `createGrantBody` in
// apps/console/app/api/cli/grants/route.ts, where both are `z.enum`. Validating them here is the
// provable-subset rule: a value outside the enum is refused by the server for certain, so refusing
// it in the CLI cannot hide a grant the caller could otherwise have made — while the server's
// answer is a bare "Invalid request body" that never says which field was wrong.
var (
	grantPrincipalTypes = []string{"user", "team"}
	grantEffects        = []string{"allow", "deny"}
)

// grantResourceTypeSuggestions are the resource kinds the picker offers. They are SUGGESTIONS and
// nothing validates against them: `resource_type` is `z.string().min(1)` on the wire, so a kind
// this list does not know is stored, not refused, and a CLI that rejected it would be refusing
// something the server accepts.
var grantResourceTypeSuggestions = []string{"org", "project", "runner", "cloud_identity"}

// uuidPattern is the shape `z.uuid()` accepts on the grants route.
var uuidPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

// looksLikeUUID reports whether v is already the id the server wants.
func looksLikeUUID(v string) bool { return uuidPattern.MatchString(v) }

// ── grants add: the principal and the role are lookup keys ──────────────────────────────────────

// grantPrincipalChoices lists the principals of one kind, addressable by email (users) or name
// (teams).
//
// For `user` the id is the USER id, not the member id: the PDP reads
// `g.principal_type = 'user' and g.principal_id = <user id>`, and the grants list joins
// `grants.principal_id` to `user.id`. Passing a member id here produces a grant that is stored,
// syncs a tuple, and grants nobody anything — a failure with no error anywhere.
func grantPrincipalChoices(c interface {
	memberLister
	teamLister
}, orgID, principalType string) func() ([]orgChoice, error) {
	return func() ([]orgChoice, error) {
		if strings.EqualFold(principalType, "team") {
			return teamChoices(c, orgID)()
		}
		members, err := c.ListMembers(orgID)
		if err != nil {
			return nil, fmt.Errorf("failed to list members: %w", err)
		}
		out := make([]orgChoice, len(members))
		for i, m := range members {
			out[i] = orgChoice{ID: m.UserID, Label: memberLabel(m), Keys: []string{m.Email}}
		}
		return out, nil
	}
}

// resolveByNameOrID turns a value that may be a uuid OR a human name into the id the server wants.
//
// A uuid passes straight through with no round trip. Anything else is looked up, and that is safe
// for exactly the reason the provable-subset rule gives: the field is `z.uuid()` on the wire, so a
// non-uuid would be refused for certain — resolving it can only turn a guaranteed failure into a
// success, never hide a value that would have worked.
func resolveByNameOrID(spec orgPickSpec, v string, list func() ([]orgChoice, error)) (orgRef, error) {
	v = strings.TrimSpace(v)
	if v == "" {
		return orgRef{}, nil
	}
	if looksLikeUUID(v) {
		return orgRef{ID: v}, nil
	}
	choices, err := list()
	if err != nil {
		return orgRef{}, err
	}
	if len(choices) == 0 {
		return orgRef{}, fmt.Errorf("%s", spec.Empty)
	}
	for _, c := range choices {
		if c.matches(v) {
			return orgRef{ID: c.ID, Summary: c.Label}, nil
		}
	}
	return orgRef{}, fmt.Errorf("no %s named %q (have: %s)", spec.Noun, v, orgChoiceKeys(choices))
}

// ── the permission catalog, from the server ─────────────────────────────────────────────────────

// permissionCatalog is every permission key the org's roles carry, sorted and de-duplicated.
//
// It is the SERVER's catalog, not a list typed here. `GET /api/cli/roles` expands the `owner`
// template's `"*"` to every registered key (builtinRoleWires in the route), so the union over the
// returned roles is the same set `POST /api/cli/roles` sanitises against. A key added to
// `PERMISSIONS` in the console reaches this picker with nobody editing the CLI; a hand-written copy
// here would have stopped agreeing on the first new resource.
// errNoPermissionCatalog is the answer when the server returned roles that carry no permission keys
// at all.
//
// A multi-select with no options is a box nobody can answer, and "the catalog came back empty" is a
// different problem from "you chose none" — so it is an error naming the flag, not a form.
var errNoPermissionCatalog = fmt.Errorf(
	"the control plane returned no permission keys, so there is nothing to choose from — " +
		"pass --permission <resource:action> instead")

func permissionCatalog(roles []api.Role) []string {
	seen := map[string]bool{}
	var out []string
	for _, r := range roles {
		for _, k := range r.PermissionKeys {
			if k == "" || seen[k] {
				continue
			}
			seen[k] = true
			out = append(out, k)
		}
	}
	sort.Strings(out)
	return out
}

// ── the forms ───────────────────────────────────────────────────────────────────────────────────

// promptMembersAdd asks for the values `members add` was not given: the invitee's email, and the
// role to invite them as.
//
// The role options come from the org's own roles, so an org with a custom `deployers` role can
// invite straight into it. `current` is the value of --role, whose default the server accepts as a
// plain string, so it is offered as an option even when it is not one of the org's role names —
// refusing to show the caller their own default would be the CLI disagreeing with itself.
//
// offerOrgRoles says whether the role list can be vouched for. `GET /api/cli/roles` is scoped by
// the X-Alethia-Org header, so the question is whether that header names the same org the
// invitation lands in — and a list we cannot vouch for is worse than no list, because `role` is a
// free string on the wire and a name that does not exist there reads as a valid choice.
//
// It USED to be false whenever `--org` was passed: the flag was registered on `members`/`teams`
// alone and moved only the request PATH, leaving the header on the active context. #3817 made
// `--org` a root persistent flag that sets BOTH — currentOrgID and api.setAuthHeaders read one
// value — so the two can no longer disagree and the caller passes true. The parameter stays because
// it is the property being relied on, not a constant: if a future scope ever reaches the path
// without reaching the header, this is the argument that has to become false again.
func promptMembersAdd(c roleLister, email, current string, offerOrgRoles bool) (string, string, error) {
	emailField := mustOrgField("alethia members add", orgFieldKeyEmail)
	roleField := mustOrgField("alethia members add", orgFieldKeyRole)
	if !canPromptForm() {
		return "", "", refuseNoForm(emailField, roleField)
	}

	var groups []*huh.Group
	if email == "" {
		groups = append(groups, huh.NewGroup(
			huh.NewInput().
				Title(emailField.Title).
				Description(emailField.Description).
				Value(&email).
				Validate(requireEmail),
		))
	}

	if offerOrgRoles {
		roles, err := c.ListRoles()
		if err != nil {
			return "", "", fmt.Errorf("failed to list roles: %w", err)
		}
		groups = append(groups, huh.NewGroup(
			huh.NewSelect[string]().
				Title(roleField.Title).
				Description(roleField.Description).
				Options(roleOptions(roles, current)...).
				Value(&current),
		))
	} else {
		groups = append(groups, huh.NewGroup(
			huh.NewInput().
				Title(roleField.Title).
				Description("A role name in the organization you are inviting into").
				Value(&current).
				Validate(requireNonEmpty("role")),
		))
	}

	if err := runHuhForm(groups...); err != nil {
		return "", "", err
	}
	return strings.TrimSpace(email), strings.TrimSpace(current), nil
}

// roleOptions renders the org's role names as picker options, with current pre-selected and
// included even when the server's role list does not carry it.
func roleOptions(roles []api.Role, current string) []huh.Option[string] {
	var options []huh.Option[string]
	seen := false
	for _, r := range roles {
		if strings.EqualFold(r.Name, current) {
			seen = true
		}
		options = append(options, huh.NewOption(roleLabel(r), r.Name))
	}
	if !seen && current != "" {
		options = append([]huh.Option[string]{huh.NewOption(current, current)}, options...)
	}
	return options
}

// requireEmail rejects an input that cannot be an email address.
//
// Deliberately shallow: the server's check is `z.string().email()`, and a CLI that were stricter
// would refuse an address the control plane accepts. It catches the empty answer and the missing
// `@`, which is what a person actually typos into this box.
func requireEmail(v string) error {
	v = strings.TrimSpace(v)
	if v == "" {
		return fmt.Errorf("an email address is required")
	}
	if !strings.Contains(v, "@") {
		return fmt.Errorf("%q is not an email address", v)
	}
	return nil
}

// requireNonEmpty rejects a blank answer to a required text field.
func requireNonEmpty(what string) func(string) error {
	return func(v string) error {
		if strings.TrimSpace(v) == "" {
			return fmt.Errorf("a %s is required", what)
		}
		return nil
	}
}

// promptName asks for a single required name, described by its own spec entry.
func promptName(command, key string) (string, error) {
	field := mustOrgField(command, key)
	if !canPromptForm() {
		return "", refuseNoForm(field)
	}
	var name string
	if err := runHuhForm(
		huh.NewGroup(
			huh.NewInput().
				Title(field.Title).
				Description(field.Description).
				Value(&name).
				Validate(requireNonEmpty(strings.ToLower(field.Title))),
		),
	); err != nil {
		return "", err
	}
	return strings.TrimSpace(name), nil
}

// promptRolePermissions asks which permission keys a new custom role should carry.
//
// A multi-select over the SERVER's catalog, so nothing here can drift from what the route accepts.
// An empty catalog is refused rather than shown: a multi-select with no options is a box a user
// cannot answer, and "the server returned no roles" is a different problem from "you chose none".
func promptRolePermissions(c roleLister, current []string) ([]string, error) {
	field := mustOrgField("alethia roles create", orgFieldKeyPermissions)
	if !canPromptForm() {
		return nil, refuseNoForm(field)
	}
	roles, err := c.ListRoles()
	if err != nil {
		return nil, fmt.Errorf("failed to list roles: %w", err)
	}
	catalog := permissionCatalog(roles)
	if len(catalog) == 0 {
		return nil, errNoPermissionCatalog
	}
	options := make([]huh.Option[string], len(catalog))
	for i, k := range catalog {
		options[i] = huh.NewOption(k, k)
	}
	chosen := append([]string{}, current...)
	if err := runHuhForm(
		huh.NewGroup(
			huh.NewMultiSelect[string]().
				Title(field.Title).
				Description(field.Description).
				Options(options...).
				Value(&chosen),
		),
	); err != nil {
		return nil, err
	}
	return chosen, nil
}

// grantsAddAnswers is one filled-in `grants add`.
type grantsAddAnswers struct {
	PrincipalType string
	Principal     string
	Effect        string
	RoleID        string
	Permission    string
	ResourceType  string
	ResourceID    string
}

// promptGrantsAdd asks the whole grant.
//
// It runs in two passes on purpose. The principal LIST depends on the principal KIND, and the value
// bound depends on whether the caller is binding a role or a single permission, so a single form
// would have to offer every member and every team at once and both a role picker and a permission
// picker — which is how a form ends up asking a question that cannot apply.
func promptGrantsAdd(c interface {
	memberLister
	teamLister
	roleLister
}, orgID string, in grantsAddAnswers) (grantsAddAnswers, error) {
	kindField := mustOrgField("alethia grants add", orgFieldKeyPrincipalType)
	effectField := mustOrgField("alethia grants add", orgFieldKeyEffect)
	resourceTypeField := mustOrgField("alethia grants add", orgFieldKeyResourceType)
	resourceField := mustOrgField("alethia grants add", orgFieldKeyResource)
	principalField := mustOrgField("alethia grants add", orgFieldKeyPrincipal)
	roleField := mustOrgField("alethia grants add", orgFieldKeyBoundRole)
	permField := mustOrgField("alethia grants add", orgFieldKeyPermission)
	if !canPromptForm() {
		return in, refuseNoForm(principalField, roleField, permField)
	}

	bindRole := in.Permission == ""
	if err := runHuhForm(
		huh.NewGroup(
			huh.NewSelect[string]().
				Title(kindField.Title).
				Description(kindField.Description).
				Options(stringOptions(grantPrincipalTypes)...).
				Value(&in.PrincipalType),
			huh.NewSelect[string]().
				Title(effectField.Title).
				Description(effectField.Description).
				Options(stringOptions(grantEffects)...).
				Value(&in.Effect),
			huh.NewSelect[bool]().
				Title("Bind").
				Description("A grant carries exactly one of a role or a single permission").
				Options(
					huh.NewOption("A role", true),
					huh.NewOption("A single permission", false),
				).
				Value(&bindRole),
		),
	); err != nil {
		return in, err
	}

	principal, err := resolveOrgChoice(
		grantPrincipalPickSpec, "", "", grantPrincipalChoices(c, orgID, in.PrincipalType))
	if err != nil {
		return in, err
	}
	in.Principal = principal.ID

	roles, err := c.ListRoles()
	if err != nil {
		return in, fmt.Errorf("failed to list roles: %w", err)
	}
	if bindRole {
		in.Permission = ""
		if len(roles) == 0 {
			return in, fmt.Errorf("%s", grantRolePickSpec.Empty)
		}
		choices := make([]orgChoice, len(roles))
		for i, r := range roles {
			choices[i] = orgChoice{ID: r.ID, Label: roleLabel(r), Keys: []string{r.Name}}
		}
		bound, err := pickOrgChoice(grantRolePickSpec, choices)
		if err != nil {
			return in, err
		}
		in.RoleID = bound.ID
	} else {
		in.RoleID = ""
		catalog := permissionCatalog(roles)
		if len(catalog) == 0 {
			return in, errNoPermissionCatalog
		}
		if err := runHuhForm(
			huh.NewGroup(
				huh.NewSelect[string]().
					Title(permField.Title).
					Description(permField.Description).
					Options(stringOptions(catalog)...).
					Value(&in.Permission),
			),
		); err != nil {
			return in, err
		}
	}

	if err := runHuhForm(
		huh.NewGroup(
			huh.NewSelect[string]().
				Title(resourceTypeField.Title).
				Description(resourceTypeField.Description).
				Options(stringOptions(grantResourceTypeSuggestions)...).
				Value(&in.ResourceType),
			huh.NewInput().
				Title(resourceField.Title).
				Description(resourceField.Description).
				Value(&in.ResourceID),
		),
	); err != nil {
		return in, err
	}
	in.ResourceID = strings.TrimSpace(in.ResourceID)
	return in, nil
}

// stringOptions renders a closed set as picker options whose label is the value.
func stringOptions(values []string) []huh.Option[string] {
	out := make([]huh.Option[string], len(values))
	for i, v := range values {
		out[i] = huh.NewOption(v, v)
	}
	return out
}

// requireOneOf rejects a value outside a closed set, naming the set.
//
// The server's answer to a bad enum is a bare "Invalid request body" that does not say which field
// was wrong; this says which flag and which values.
func requireOneOf(flag, value string, allowed []string) error {
	_, err := canonicalOneOf(flag, value, allowed)
	return err
}

// canonicalOneOf validates a case-insensitive enum and returns its wire spelling.
func canonicalOneOf(flag, value string, allowed []string) (string, error) {
	for _, a := range allowed {
		if strings.EqualFold(a, value) {
			return a, nil
		}
	}
	return "", fmt.Errorf("--%s %q is not one of: %s", flag, value, strings.Join(allowed, ", "))
}
