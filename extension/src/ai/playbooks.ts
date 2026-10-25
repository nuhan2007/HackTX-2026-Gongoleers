// What to look for in each kind of problem. The solver names the domain and the method once; from then on every reading of the work
// and every hint gets the matching playbook, so myTA knows what a typical slip looks like for THIS kind of problem (a flipped sign in
// a KCL term, a dropped chain-rule factor, an off-by-one) instead of only knowing the answer. Private: it only ever goes to the model.
import type { Domain } from '../shared/types';

const CIRCUITS = `Circuit analysis. Typical slips, in the order students make them:
- Node-voltage: no reference (ground) node chosen, or two different ones used. KCL written with mixed conventions (some terms "current leaving",
  others "entering"): pick one and use it for every term. Resistor current written (Vb - Va)/R when the equation is "leaving node a" (it must be
  (Va - Vb)/R). Resistors to ground written with the wrong sign. A current source left out of the equation, or added with the wrong sign.
- A voltage source between two non-reference nodes needs a supernode: one KCL for the pair plus the constraint V_b - V_a = V_s. Writing a
  KCL for each of the two nodes separately is the classic error. A voltage source between a node and ground simply fixes that node's voltage.
- Dependent sources need the controlling variable expressed in node voltages (an extra equation), and are never turned off for Thevenin resistance.
- Mesh analysis: all mesh currents the same direction (clockwise), KVL signs follow that direction, a resistor shared by two meshes carries the
  DIFFERENCE of the mesh currents, a current source between meshes gives a supermesh or fixes a mesh current.
- Thevenin/Norton: remove the load first; V_th is the open-circuit voltage; R_th is found with independent sources zeroed (voltage sources
  shorted, current sources opened); Norton current is the short-circuit current; R_N = R_th.
- Ideal op-amp: V+ = V- (negative feedback) and no current into the inputs; the output node needs no KCL of its own.
- AC: impedances j*w*L and 1/(j*w*C), complex arithmetic, magnitude and phase asked for separately. Transients: time constant tau = RC or L/R.
- Units and prefixes: k, m, u (micro), n, p. kOhm with mA gives volts directly. Arithmetic when solving the simultaneous equations is
  where most final answers go wrong, so check the elimination step too. The asked quantity may be a voltage ACROSS an element (a difference of
  two node voltages), not a node voltage; or a current with a stated direction.`;

const PHYSICS = `Physics. Typical slips: wrong or missing units, unit conversions (cm to m, g to kg, degrees to radians), vector components with
the wrong sign or the wrong trig function (sin vs cos), forgetting a force in the free-body diagram (friction, normal, tension), using
the wrong sign convention for direction, mixing up speed and velocity or mass and weight, plugging numbers in before the algebra is
finished and losing a factor, energy or momentum not conserved where the problem says it is, significant figures.`;

const CALCULUS = `Calculus. Typical slips: a dropped chain-rule factor (the derivative of the inside), product rule written as a product of
derivatives, a lost constant or minus sign when differentiating trig functions, forgetting + C, wrong integration bounds after a
substitution, an algebra slip when simplifying, limits that need a rewrite (0/0) treated as plain substitution, a derivative taken with
respect to the wrong variable, sign of the answer on a related-rates problem.`;

const ALGEBRA = `Algebra. Typical slips: a sign lost when moving a term across the equals sign, a minus sign not distributed over a bracket, only part of an
expression multiplied when clearing a fraction, squaring a sum as the sum of squares, cancelling a term instead of a factor, dividing by
an expression that could be zero, losing a root (dropping the negative square root), an extraneous solution not checked, arithmetic slips
with negative numbers and fractions.`;

const GEOMETRY = `Geometry. Typical slips: using the diameter for the radius (or the reverse), perimeter vs area vs volume formulas, units that are squared or
cubed, similar triangles with the sides matched in the wrong order, angles in degrees vs radians, a right-angle assumption the figure does
not support, forgetting that the figure is not to scale.`;

const STATISTICS = `Statistics and probability. Typical slips: variance vs standard deviation, population vs sample formulas (n vs n-1), one-tailed vs
two-tailed tests, the wrong distribution, adding probabilities that are not mutually exclusive or multiplying ones that are not independent,
conditional probability turned around, rounding in the middle of a calculation, reading the z or t table the wrong way.`;

const CHEMISTRY = `Chemistry. Typical slips: an unbalanced equation, mole ratios taken from the wrong coefficients, grams and moles mixed up, molar mass added
up wrongly, the limiting reagent not identified, units and significant figures, logarithm slips in pH problems, temperature not in kelvin,
a sign error in an enthalpy or equilibrium expression, an ICE table whose x is not carried through.`;

const LINEAR_ALGEBRA = `Linear algebra. Typical slips: a row operation applied to only part of a row, a sign error in a determinant or cofactor, matrix products
in the wrong order, the transpose forgotten, treating a non-invertible matrix as invertible, free variables not reported, eigenvector
not normalized when the problem asks, dimensions that do not match.`;

const PROGRAMMING = `Programming. Typical slips: off-by-one in loop bounds or indices, integer division, a variable used before it is set or out of scope,
comparing with = instead of ==, strings compared by reference, mutating a collection while looping over it, a base case missing in a
recursion, wrong complexity reasoning, a return that sits inside a loop. For code on screen, mentally run it on a small input.`;

const LOGIC = `Logic and proofs. Typical slips: affirming the consequent, a quantifier order swapped, a negation not pushed through correctly, a case
missing, a claim in the proof that is only true for the example, circular reasoning, an induction step that does not use the hypothesis.`;

const PLAYBOOKS: Record<Domain, string> = {
  circuits: CIRCUITS,
  physics: PHYSICS,
  calculus: CALCULUS,
  algebra: ALGEBRA,
  geometry: GEOMETRY,
  statistics: STATISTICS,
  chemistry: CHEMISTRY,
  linear_algebra: LINEAR_ALGEBRA,
  programming: PROGRAMMING,
  logic: LOGIC,
  other: '',
};

/** A circuit problem can be labelled anything ("physics", "other"); the topic words are the more reliable cue. */
const CIRCUIT_WORDS = /\b(kcl|kvl|node.?voltage|mesh|thevenin|norton|op.?amp|resistor|capacitor|inductor|ohm|kirchhoff|circuit|phasor|impedance|supernode)\b/i;

/** The playbook for a problem: by the domain the solver named, and by the method when that points somewhere else. */
export function playbookFor(domain: Domain | undefined, problemKind?: string, conceptTags: string[] = []): string {
  const hint = `${problemKind ?? ''} ${conceptTags.join(' ')}`;
  if (domain === 'circuits' || CIRCUIT_WORDS.test(hint)) return CIRCUITS;
  return (domain && PLAYBOOKS[domain]) || '';
}
