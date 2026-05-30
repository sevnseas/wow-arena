// Task 1: Multi-agent Lotka-Volterra ecosystem engine (Foxes / Rabbits / Grass)
// with a zero-allocation fixed entity pool and an O(1) spatial hash grid.
//
// THE MEMORY CONTRACT (the whole point of Task 1):
//   * Every entity lives in a fixed-size, contiguous, struct-of-arrays pool of
//     MAX_TOTAL_ENTITIES slots allocated ONCE in the constructor.
//   * Birth = pop a slot index off a preallocated free-list stack.
//     Death  = push that index back. No std::vector resize, no `new`, nothing
//     heap-touching happens inside step(). RSS stays flat under churn.
//   * Neighbour proximity uses a counting-sort spatial grid rebuilt each step
//     in O(N) into preallocated buffers -> O(1) amortised neighbour lookups,
//     no N^2 blowup at hundreds of entities.
//
// Entity types: 0 = EMPTY, 1 = GRASS, 2 = RABBIT, 3 = FOX.
//
// The world is [0, world] x [0, world]. cell_size defaults to the vision/eat
// radius so a 3x3 cell sweep covers every possible interaction neighbour.
//
#include <pybind11/pybind11.h>
#include <pybind11/numpy.h>
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <limits>
#include <random>
#include <stdexcept>
#include <vector>

namespace py = pybind11;

static constexpr int MAX_TOTAL_ENTITIES = 1024;
static constexpr int EMPTY  = 0;
static constexpr int GRASS  = 1;
static constexpr int RABBIT = 2;
static constexpr int FOX    = 3;
static constexpr int N_DIRS = 8;

// per-agent observation schema -- MUST match eco_policy.py
static constexpr int SELF_DIM = 4;     // [x, y, energy_norm, is_fox]
static constexpr int ENT_DIM  = 6;     // [active, rel_dx, rel_dy, is_rab, is_fox, is_grass]
static constexpr int MAX_VIS  = 16;
static constexpr int DENSITY_DIRS = 8;
static constexpr int DENSITY_BANDS = 3;
static constexpr int DENSITY_DIM = DENSITY_DIRS * DENSITY_BANDS;
static constexpr int LOCAL_DIM = SELF_DIM + MAX_VIS * ENT_DIM;
static constexpr int AOBS = LOCAL_DIM + DENSITY_DIM;   // 124
static constexpr int GROUP_DIM = 5; // [same_species, threats, prey, local_agents, proximity]
static constexpr int ASTAR_MAX_EXPANSIONS = 32;

static const float DIRX[8] = { 1.f, 0.70710678f, 0.f, -0.70710678f,
                              -1.f, -0.70710678f, 0.f, 0.70710678f };
static const float DIRY[8] = { 0.f, 0.70710678f, 1.f, 0.70710678f,
                               0.f, -0.70710678f, -1.f, -0.70710678f };

struct Birth { int8_t type; float x, y, e; };

class EcoEngine {
public:
    EcoEngine(float world, float cell_size, float vision, float eat_radius,
              float move_speed,
              float rabbit_metab, float fox_metab, float rabbit_move_cost,
              float grass_energy, float rabbit_energy_to_fox,
              float repro_threshold, float init_energy,
              int n_rabbits0, int n_foxes0, int n_grass0,
              int grass_max, float grass_spawn_rate,
              float max_age, int refuge_rabbits, int refuge_foxes,
              bool use_grid, uint64_t seed)
        : world(world), cell(cell_size), vision(vision), eat_r(eat_radius),
          speed(move_speed),
          rabbit_metab(rabbit_metab), fox_metab(fox_metab),
          rabbit_move_cost(rabbit_move_cost),
          grass_energy(grass_energy), rabbit_energy_to_fox(rabbit_energy_to_fox),
          repro_threshold(repro_threshold), init_energy(init_energy),
          n_rabbits0(n_rabbits0), n_foxes0(n_foxes0), n_grass0(n_grass0),
          grass_max(grass_max), grass_spawn_rate(grass_spawn_rate),
          max_age(max_age), refuge_rabbits(refuge_rabbits),
          refuge_foxes(refuge_foxes), use_grid(use_grid), rng(seed),
          // fixed pools, allocated exactly once
          etype(MAX_TOTAL_ENTITIES, EMPTY),
          ex(MAX_TOTAL_ENTITIES, 0.f), ey(MAX_TOTAL_ENTITIES, 0.f),
          energy(MAX_TOTAL_ENTITIES, 0.f), age(MAX_TOTAL_ENTITIES, 0.f),
          dir(MAX_TOTAL_ENTITIES, 0),
          entity_id(MAX_TOTAL_ENTITIES, 0),
          free_stack(MAX_TOTAL_ENTITIES, 0),
          cell_of(MAX_TOTAL_ENTITIES, 0),
          sorted_idx(MAX_TOTAL_ENTITIES, 0),
          alist(MAX_TOTAL_ENTITIES, 0), apos(MAX_TOTAL_ENTITIES, -1),
          dead(MAX_TOTAL_ENTITIES, 0),
          kill_q(MAX_TOTAL_ENTITIES, 0), birth_q(MAX_TOTAL_ENTITIES),
          obs_buf({(size_t)MAX_TOTAL_ENTITIES, (size_t)AOBS}),
          slot_buf({(size_t)MAX_TOTAL_ENTITIES}),
          type_buf({(size_t)MAX_TOTAL_ENTITIES}),
          id_buf({(size_t)MAX_TOTAL_ENTITIES}),
          group_buf({(size_t)MAX_TOTAL_ENTITIES, (size_t)GROUP_DIM})
    {
        rstate = seed ? seed : 0x9e3779b97f4a7c15ULL;
        ncx = std::max(1, (int)std::floor(world / cell));
        ncy = ncx;
        ncells = ncx * ncy;
        cell_count.assign(ncells + 1, 0);
        cell_cursor.assign(ncells + 1, 0);
        obstacles.assign(ncells, 0);
        astar_g.assign(ncells, 0.f);
        astar_parent.assign(ncells, -1);
        astar_seen.assign(ncells, 0);
        astar_closed.assign(ncells, 0);
        astar_open.assign(ncells, 0);
        reset(seed);
    }

    void reset(uint64_t seed) {
        rng.seed(seed);
        rstate = seed ? seed : 0x9e3779b97f4a7c15ULL;
        // wipe pool, rebuild free-list (descending so we hand out 0,1,2,... first)
        for (int i = 0; i < MAX_TOTAL_ENTITIES; ++i) { etype[i] = EMPTY; apos[i] = -1; }
        free_top = 0;
        for (int i = MAX_TOTAL_ENTITIES - 1; i >= 0; --i)
            free_stack[free_top++] = i;
        n_active = 0;
        n_rabbits = n_foxes = n_grass = 0;
        grass_accum = 0.f;
        for (int i = 0; i < n_grass0;   ++i) spawn(GRASS,  rx(), rx(), grass_energy);
        for (int i = 0; i < n_rabbits0; ++i) spawn(RABBIT, rx(), rx(), init_energy);
        for (int i = 0; i < n_foxes0;   ++i) spawn(FOX,    rx(), rx(), init_energy);
    }

    // One ecological tick. `actions` is an optional [MAX_TOTAL_ENTITIES, 2]
    // float array of egocentric destination offsets. Non-finite coordinates (or
    // absent actions) request a random walk for that slot.
    void step(py::array_t<float, py::array::c_style | py::array::forcecast> actions,
              bool use_actions) {
        if (use_actions && (actions.ndim() != 2 || actions.shape(0) < MAX_TOTAL_ENTITIES
                           || actions.shape(1) != 2))
            throw std::runtime_error("actions must have shape [capacity, 2]");
        const float* a = use_actions ? actions.data() : nullptr;
        last_path_queries = last_path_expansions = last_path_fallbacks = 0;
        last_invalid_targets = 0;
        // snapshot: only entities alive at the start of the tick act this frame.
        const int cnt = n_active;

        // --- movement + metabolism (mutates only pos/energy/age: safe) ---
        for (int s = 0; s < cnt; ++s) {
            int i = alist[s];
            int t = etype[i];
            if (t == GRASS) continue;
            float vx, vy;
            if (a && std::isfinite(a[2 * i]) && std::isfinite(a[2 * i + 1])) {
                float dx = a[2 * i], dy = a[2 * i + 1];
                float steer = (t == FOX) ? fox_steering_scale() : 1.f;
                float mag = std::sqrt(dx * dx + dy * dy);
                float max_target = vision * steer;
                if (mag > max_target && mag > 0.f) {
                    dx *= max_target / mag; dy *= max_target / mag;
                }
                path_velocity(i, dx, dy, vx, vy);
                apply_move(i, vx, vy, (t == FOX) ? steer : 1.f);
            } else {
                int d = dir[i] = (int)(xr() & 7);
                apply_move(i, DIRX[d], DIRY[d], 1.f);
            }
            age[i] += 1.f;
            if (t == RABBIT) energy[i] -= (rabbit_metab + rabbit_move_cost);
            else             energy[i] -= fox_metab;       // fox fixed cost
        }

        if (use_grid) build_grid();

        // --- interactions: rabbits eat grass, foxes eat rabbits ---
        // Deferred: mark prey dead, queue kills (a dead prey can't be eaten
        // twice and can't act later this tick).
        int nk = 0;
        for (int s = 0; s < cnt; ++s) {
            int i = alist[s];
            if (dead[i]) continue;
            int t = etype[i];
            if (t == RABBIT) {
                int prey = nearest_prey(i, GRASS);
                if (prey >= 0) { energy[i] += grass_energy; dead[prey] = 1; kill_q[nk++] = prey; }
            } else if (t == FOX) {
                int prey = nearest_prey(i, RABBIT);
                if (prey >= 0) { energy[i] += rabbit_energy_to_fox; dead[prey] = 1; kill_q[nk++] = prey; }
            }
        }

        // --- reproduction (binary fission) + starvation/age death ---
        int nb = 0;
        for (int s = 0; s < cnt; ++s) {
            int i = alist[s];
            if (dead[i] || etype[i] == GRASS) continue;
            int t = etype[i];
            if (energy[i] <= 0.f || (max_age > 0.f && age[i] >= max_age)) {
                dead[i] = 1; kill_q[nk++] = i;
                continue;
            }
            if (energy[i] >= repro_threshold) {
                float child_e = energy[i] * 0.5f;
                energy[i] = child_e;
                age[i] = 0.f;
                Birth b; b.type = (int8_t)t;
                b.x = clampw(ex[i] + (xf() - 0.5f) * speed);
                b.y = clampw(ey[i] + (xf() - 0.5f) * speed);
                b.e = child_e;
                birth_q[nb++] = b;
            }
        }

        // apply deferred kills then births (births may reuse just-freed slots)
        for (int k = 0; k < nk; ++k) { dead[kill_q[k]] = 0; kill(kill_q[k]); }
        for (int b = 0; b < nb && free_top > refuge_reserve(); ++b)
            spawn(birth_q[b].type, birth_q[b].x, birth_q[b].y, birth_q[b].e);

        // --- grass regrowth (passive energy nodes) ---
        grass_accum += grass_spawn_rate;
        while (grass_accum >= 1.f && n_grass < grass_max
               && free_top > refuge_reserve()) {
            spawn(GRASS, rx(), rx(), grass_energy);
            grass_accum -= 1.f;
        }

        // --- refuge / source populations (mechanical anti-extinction guardrail) ---
        // A protected breeding refuge slowly re-seeds a species that has crashed,
        // so the system never hits an unrecoverable 0-population dead state and
        // oscillations can resume. Repopulate at most one of each per tick.
        while (n_rabbits < refuge_rabbits && free_top > 0)
            spawn(RABBIT, rx(), rx(), init_energy);
        while (n_foxes < refuge_foxes && free_top > 0)
            spawn(FOX, rx(), rx(), init_energy);
        steps++;
    }

    // Build per-agent observations (rabbits + foxes) in the eco_policy layout.
    // Fills obs_buf[n_agents, AOBS], slot_buf[n_agents], type_buf[n_agents].
    // Returns n_agents. Python slices by type and routes to the two policies.
    int build_agent_obs() {
        build_grid();
        float* o = obs_buf.mutable_data();
        int32_t* sl = (int32_t*)slot_buf.mutable_data();
        int8_t*  ty = (int8_t*)type_buf.mutable_data();
        uint64_t* ids = (uint64_t*)id_buf.mutable_data();
        float* gm = group_buf.mutable_data();
        const float inv_v = 1.f / vision;
        const float inv_e = 1.f / repro_threshold;
        const int R = (int)std::ceil(vision / cell);
        const float vis2 = vision * vision;
        int na = 0;
        for (int s = 0; s < n_active; ++s) {
            int i = alist[s];
            int t = etype[i];
            if (t != RABBIT && t != FOX) continue;
            float px = ex[i], py_ = ey[i];
            float* row = o + (size_t)na * AOBS;
            row[0] = px / world * 2.f - 1.f;
            row[1] = py_ / world * 2.f - 1.f;
            float en = energy[i] * inv_e; row[2] = en > 1.f ? 1.f : en;
            row[3] = (t == FOX) ? 1.f : 0.f;
            for (int k = 0; k < DENSITY_DIM; ++k) row[LOCAL_DIM + k] = 0.f;
            // One grid sweep gathers exact nearest neighbours, coarse global
            // density, and reward metrics without adding another local pass.
            float nd[MAX_VIS]; int nj[MAX_VIS]; int nc = 0;
            float density[DENSITY_DIM] = {0.f};
            int same_species = 0, threats = 0, prey = 0, local_agents = 0;
            float same_proximity = 0.f;
            int cx = (int)(px / cell), cy = (int)(py_ / cell);
            if (cx < 0) cx = 0; else if (cx >= ncx) cx = ncx - 1;
            if (cy < 0) cy = 0; else if (cy >= ncy) cy = ncy - 1;
            for (int dy = -R; dy <= R; ++dy) {
                int yy = cy + dy; if (yy < 0 || yy >= ncy) continue;
                for (int dx = -R; dx <= R; ++dx) {
                    int xx = cx + dx; if (xx < 0 || xx >= ncx) continue;
                    int c = yy * ncx + xx;
                    for (int q = cell_count[c]; q < cell_count[c + 1]; ++q) {
                        int j = sorted_idx[q];
                        if (j == i) continue;
                        float ddx = ex[j] - px, ddy = ey[j] - py_;
                        float d2 = ddx*ddx + ddy*ddy;
                        if (d2 > vis2) continue;
                        float dist = std::sqrt(d2);
                        int band = std::min(DENSITY_BANDS - 1,
                            (int)(dist * DENSITY_BANDS * inv_v));
                        float angle = std::atan2(ddy, ddx);
                        int sector = (int)std::floor((angle + 3.14159265f / 8.f)
                            * (4.f / 3.14159265f));
                        sector = (sector % DENSITY_DIRS + DENSITY_DIRS) % DENSITY_DIRS;
                        density[band * DENSITY_DIRS + sector] += 1.f;
                        int jt = etype[j];
                        if (jt == RABBIT || jt == FOX) local_agents++;
                        if (jt == t) {
                            same_species++;
                            same_proximity += 1.f - dist * inv_v;
                        }
                        if (t == RABBIT && jt == FOX) threats++;
                        if (t == FOX && jt == RABBIT) prey++;
                        if (nc < MAX_VIS) { nd[nc] = d2; nj[nc] = j; nc++; }
                        else {  // replace current farthest if this is nearer
                            int mx = 0; for (int m = 1; m < MAX_VIS; ++m)
                                if (nd[m] > nd[mx]) mx = m;
                            if (d2 < nd[mx]) { nd[mx] = d2; nj[mx] = j; }
                        }
                    }
                }
            }
            // write entity rows (order irrelevant: trunk is permutation-invariant)
            for (int k = 0; k < MAX_VIS; ++k) {
                float* e = row + SELF_DIM + k * ENT_DIM;
                if (k < nc) {
                    int j = nj[k]; int jt = etype[j];
                    e[0] = 1.f;
                    e[1] = (ex[j] - px) * inv_v;
                    e[2] = (ey[j] - py_) * inv_v;
                    e[3] = (jt == RABBIT) ? 1.f : 0.f;
                    e[4] = (jt == FOX) ? 1.f : 0.f;
                    e[5] = (jt == GRASS) ? 1.f : 0.f;
                } else {
                    for (int m = 0; m < ENT_DIM; ++m) e[m] = 0.f;
                }
            }
            for (int k = 0; k < DENSITY_DIM; ++k)
                row[LOCAL_DIM + k] = std::log10(density[k] + 1.f);
            sl[na] = i; ty[na] = (int8_t)t; ids[na] = entity_id[i];
            float* metric = gm + (size_t)na * GROUP_DIM;
            metric[0] = (float)same_species;
            metric[1] = (float)threats;
            metric[2] = (float)prey;
            metric[3] = (float)local_agents;
            metric[4] = same_proximity;
            na++;
        }
        n_agents = na;
        return na;
    }
    // views valid until the next build_agent_obs / step
    py::array_t<float>   agent_obs()   { return py::array_t<float>({(size_t)n_agents, (size_t)AOBS}, obs_buf.data()); }
    py::array_t<int32_t> agent_slots() { return py::array_t<int32_t>({(size_t)n_agents}, (int32_t*)slot_buf.data()); }
    py::array_t<int8_t>  agent_types() { return py::array_t<int8_t>({(size_t)n_agents}, (int8_t*)type_buf.data()); }
    py::array_t<uint64_t> agent_ids() { return py::array_t<uint64_t>({(size_t)n_agents}, (uint64_t*)id_buf.data()); }
    py::array_t<float> agent_group_metrics() {
        return py::array_t<float>({(size_t)n_agents, (size_t)GROUP_DIM}, group_buf.data());
    }

    void set_world(float w) { world = w; }

    // ---- accessors (zero-copy snapshots are not safe across step, so copy) ----
    py::array_t<int8_t> types() {
        return py::array_t<int8_t>({(size_t)MAX_TOTAL_ENTITIES}, etype.data());
    }
    py::array_t<float> xs() {
        return py::array_t<float>({(size_t)MAX_TOTAL_ENTITIES}, ex.data());
    }
    py::array_t<float> ys() {
        return py::array_t<float>({(size_t)MAX_TOTAL_ENTITIES}, ey.data());
    }
    py::array_t<float> energies() {
        return py::array_t<float>({(size_t)MAX_TOTAL_ENTITIES}, energy.data());
    }
    py::array_t<uint64_t> ids() {
        return py::array_t<uint64_t>({(size_t)MAX_TOTAL_ENTITIES}, entity_id.data());
    }

    void clear_obstacles() { std::fill(obstacles.begin(), obstacles.end(), 0); }
    void set_obstacle(int cx, int cy, bool blocked) {
        if (cx < 0 || cx >= ncx || cy < 0 || cy >= ncy)
            throw std::runtime_error("obstacle cell is outside the spatial grid");
        obstacles[cy * ncx + cx] = blocked ? 1 : 0;
    }
    bool is_obstacle(int cx, int cy) const {
        return cx >= 0 && cx < ncx && cy >= 0 && cy < ncy
            && obstacles[cy * ncx + cx] != 0;
    }
    void set_position(int slot, float x, float y) {
        if (slot < 0 || slot >= MAX_TOTAL_ENTITIES || etype[slot] == EMPTY)
            throw std::runtime_error("slot is not an active entity");
        ex[slot] = clampw(x); ey[slot] = clampw(y);
    }

    // Stamp a static circular pillar into the obstacle grid: every cell whose
    // centre lies within `radius` of (cx, cy) is marked blocked. Pillars are
    // geometry constants set up once after construction -- no per-step alloc.
    void add_pillar(float cx, float cy, float radius) {
        float r2 = radius * radius;
        for (int gy = 0; gy < ncy; ++gy) {
            float wy = (gy + 0.5f) * cell;
            for (int gx = 0; gx < ncx; ++gx) {
                float wx = (gx + 0.5f) * cell;
                float dx = wx - cx, dy = wy - cy;
                if (dx * dx + dy * dy <= r2) obstacles[gy * ncx + gx] = 1;
            }
        }
    }

    // Integer grid-stepped line-of-sight between two world points. Walks the
    // supercover of the segment in obstacle-cell space using an integer DDA so
    // the result is free of floating-point drift: identical to stepping the
    // exact analytic line. Returns false (occluded) the moment the ray enters a
    // blocked cell that is not an endpoint cell. Endpoint cells are exempt so an
    // entity standing on a pillar edge can still see out.
    bool line_of_sight(float x0, float y0, float x1, float y1) const {
        int cx0 = (int)(x0 / cell), cy0 = (int)(y0 / cell);
        int cx1 = (int)(x1 / cell), cy1 = (int)(y1 / cell);
        if (cx0 < 0) cx0 = 0; else if (cx0 >= ncx) cx0 = ncx - 1;
        if (cy0 < 0) cy0 = 0; else if (cy0 >= ncy) cy0 = ncy - 1;
        if (cx1 < 0) cx1 = 0; else if (cx1 >= ncx) cx1 = ncx - 1;
        if (cy1 < 0) cy1 = 0; else if (cy1 >= ncy) cy1 = ncy - 1;
        int dx = std::abs(cx1 - cx0), dy = std::abs(cy1 - cy0);
        int sx = cx0 < cx1 ? 1 : -1, sy = cy0 < cy1 ? 1 : -1;
        int x = cx0, y = cy0;
        // supercover DDA: at each step advance along whichever axis keeps the
        // running error closest to the true line; on a tie advance both (corner
        // crossing) so diagonally-touched cells are all visited.
        int err = dx - dy;
        int n = dx + dy;
        for (; n > 0; --n) {
            if (!(x == cx0 && y == cy0) && !(x == cx1 && y == cy1)
                && obstacles[y * ncx + x]) return false;
            int e2 = 2 * err;
            if (e2 - dy > dx - e2) { err -= dy; x += sx; }   // step x
            else                   { err += dx; y += sy; }   // step y
        }
        return true;
    }

    // LoS between two active entity slots (convenience for the combat layer).
    bool slots_visible(int a, int b) const {
        if (a < 0 || a >= MAX_TOTAL_ENTITIES || b < 0 || b >= MAX_TOTAL_ENTITIES
            || etype[a] == EMPTY || etype[b] == EMPTY)
            throw std::runtime_error("slot is not an active entity");
        return line_of_sight(ex[a], ey[a], ex[b], ey[b]);
    }

    int count_rabbits() const { return n_rabbits; }
    int count_foxes()   const { return n_foxes; }
    int count_grass()   const { return n_grass; }
    int active_count()  const { return n_rabbits + n_foxes + n_grass; }
    int capacity()      const { return MAX_TOTAL_ENTITIES; }
    int free_slots()    const { return free_top; }
    long step_count()   const { return steps; }
    int path_queries() const { return last_path_queries; }
    int path_expansions() const { return last_path_expansions; }
    int path_fallbacks() const { return last_path_fallbacks; }
    int invalid_targets() const { return last_invalid_targets; }
    float current_fox_steering_scale() const { return fox_steering_scale(); }

private:
    // fast xorshift RNG for the hot path (mt19937 is too slow per-entity)
    inline uint64_t xr() {
        uint64_t x = rstate;
        x ^= x << 13; x ^= x >> 7; x ^= x << 17;
        return rstate = x;
    }
    inline float xf() { return (xr() >> 40) * (1.0f / 16777216.0f); }  // [0,1)
    float uni() { return xf(); }
    float rx()  { return xf() * world; }
    float clampw(float v) { return v < 0.f ? 0.f : (v > world ? world : v); }
    int refuge_reserve() const {
        return std::max(0, refuge_rabbits - n_rabbits)
             + std::max(0, refuge_foxes - n_foxes);
    }
    float fox_steering_scale() const {
        if (refuge_rabbits <= 0) return 1.f;
        float low_water = (float)std::max(1, refuge_rabbits * 4);
        return std::max(0.35f, std::min(1.f, n_rabbits / low_water));
    }

    int spawn(int t, float x, float y, float e) {
        if (free_top == 0) return -1;            // graceful failure at cap
        int i = free_stack[--free_top];
        etype[i] = t; ex[i] = x; ey[i] = y; energy[i] = e; age[i] = 0.f;
        entity_id[i] = next_entity_id++;
        dir[i] = (int)(xr() & 7);
        apos[i] = n_active; alist[n_active++] = i;   // append to dense list
        if (t == RABBIT) n_rabbits++;
        else if (t == FOX) n_foxes++;
        else if (t == GRASS) n_grass++;
        return i;
    }
    void kill(int i) {
        int t = etype[i];
        if (t == EMPTY) return;
        if (t == RABBIT) n_rabbits--;
        else if (t == FOX) n_foxes--;
        else if (t == GRASS) n_grass--;
        etype[i] = EMPTY;
        entity_id[i] = 0;
        free_stack[free_top++] = i;
        // swap-remove from dense list
        int p = apos[i]; int last = alist[--n_active];
        alist[p] = last; apos[last] = p; apos[i] = -1;
    }

    inline int cell_index(float x, float y) const {
        int cx = (int)(x / cell); int cy = (int)(y / cell);
        if (cx < 0) cx = 0; else if (cx >= ncx) cx = ncx - 1;
        if (cy < 0) cy = 0; else if (cy >= ncy) cy = ncy - 1;
        return cy * ncx + cx;
    }

    inline float heuristic(int a, int b) const {
        int ax = a % ncx, ay = a / ncx;
        int bx = b % ncx, by = b / ncx;
        int dx = std::abs(ax - bx), dy = std::abs(ay - by);
        return (float)(std::max(dx, dy) + 0.41421356f * std::min(dx, dy));
    }

    inline void normalise(float dx, float dy, float& vx, float& vy) const {
        float mag = std::sqrt(dx * dx + dy * dy);
        if (mag > 1e-6f) { vx = dx / mag; vy = dy / mag; }
        else { vx = 0.f; vy = 0.f; }
    }

    void apply_move(int i, float vx, float vy, float speed_scale) {
        float nx = ex[i] + vx * speed * speed_scale;
        float ny = ey[i] + vy * speed * speed_scale;
        // Reflective boundaries keep everyone inside the arena.
        if (nx < 0.f) nx = -nx; else if (nx > world) nx = 2.f * world - nx;
        if (ny < 0.f) ny = -ny; else if (ny > world) ny = 2.f * world - ny;
        if (!obstacles[cell_index(nx, ny)]) {
            ex[i] = nx; ey[i] = ny; return;
        }
        // A greedy fallback may point into a wall. Preserve progress on an
        // unblocked axis and otherwise stay in place.
        if (!obstacles[cell_index(nx, ey[i])]) ex[i] = nx;
        else if (!obstacles[cell_index(ex[i], ny)]) ey[i] = ny;
    }

    void path_velocity(int i, float dx, float dy, float& vx, float& vy) {
        last_path_queries++;
        float tx = clampw(ex[i] + dx), ty = clampw(ey[i] + dy);
        int start = cell_index(ex[i], ey[i]), goal = cell_index(tx, ty);
        if (obstacles[goal]) {
            last_invalid_targets++; last_path_fallbacks++;
            normalise(dx, dy, vx, vy);
            return;
        }
        if (start == goal) {
            normalise(tx - ex[i], ty - ey[i], vx, vy);
            return;
        }
        if (++astar_stamp == 0) {
            std::fill(astar_seen.begin(), astar_seen.end(), 0);
            std::fill(astar_closed.begin(), astar_closed.end(), 0);
            astar_stamp = 1;
        }
        int open_n = 1;
        astar_open[0] = start;
        astar_seen[start] = astar_stamp;
        astar_closed[start] = 0;
        astar_g[start] = 0.f;
        astar_parent[start] = -1;
        static const int DX[8] = {1, 1, 0, -1, -1, -1, 0, 1};
        static const int DY[8] = {0, 1, 1, 1, 0, -1, -1, -1};
        static const float COST[8] = {1.f, 1.41421356f, 1.f, 1.41421356f,
                                      1.f, 1.41421356f, 1.f, 1.41421356f};
        int expansions = 0;
        while (open_n > 0 && expansions < ASTAR_MAX_EXPANSIONS) {
            int best_pos = 0;
            float best_f = std::numeric_limits<float>::max();
            for (int p = 0; p < open_n; ++p) {
                int c = astar_open[p];
                float f = astar_g[c] + heuristic(c, goal);
                if (f < best_f) { best_f = f; best_pos = p; }
            }
            int cur = astar_open[best_pos];
            astar_open[best_pos] = astar_open[--open_n];
            if (astar_closed[cur] == astar_stamp) continue;
            astar_closed[cur] = astar_stamp;
            expansions++; last_path_expansions++;
            if (cur == goal) {
                int next = goal;
                while (astar_parent[next] >= 0 && astar_parent[next] != start)
                    next = astar_parent[next];
                float nx = ((next % ncx) + 0.5f) * cell;
                float ny = ((next / ncx) + 0.5f) * cell;
                normalise(nx - ex[i], ny - ey[i], vx, vy);
                return;
            }
            int cx = cur % ncx, cy = cur / ncx;
            for (int d = 0; d < 8; ++d) {
                int xx = cx + DX[d], yy = cy + DY[d];
                if (xx < 0 || xx >= ncx || yy < 0 || yy >= ncy) continue;
                int next = yy * ncx + xx;
                if (obstacles[next] || astar_closed[next] == astar_stamp) continue;
                float ng = astar_g[cur] + COST[d];
                if (astar_seen[next] != astar_stamp || ng < astar_g[next]) {
                    bool unseen = astar_seen[next] != astar_stamp;
                    astar_seen[next] = astar_stamp;
                    astar_g[next] = ng;
                    astar_parent[next] = cur;
                    if (unseen && open_n < ncells) astar_open[open_n++] = next;
                }
            }
        }
        last_path_fallbacks++;
        normalise(dx, dy, vx, vy);
    }

    // counting-sort all active entities into per-cell contiguous runs
    void build_grid() {
        for (int c = 0; c <= ncells; ++c) cell_count[c] = 0;
        for (int s = 0; s < n_active; ++s) {
            int i = alist[s];
            int c = cell_index(ex[i], ey[i]);
            cell_of[i] = c;
            cell_count[c + 1]++;
        }
        for (int c = 0; c < ncells; ++c) cell_count[c + 1] += cell_count[c];
        for (int c = 0; c <= ncells; ++c) cell_cursor[c] = cell_count[c];
        for (int s = 0; s < n_active; ++s) {
            int i = alist[s];
            sorted_idx[cell_cursor[cell_of[i]]++] = i;
        }
    }

    // nearest active entity of `prey_type` within eat radius of consumer i
    int nearest_prey(int i, int prey_type) {
        if (!use_grid) {        // O(N) brute-force baseline -> O(N^2) per tick
            float px = ex[i], py_ = ey[i];
            float best = eat_r * eat_r; int best_j = -1;
            for (int s = 0; s < n_active; ++s) {
                int j = alist[s];
                if (etype[j] != prey_type) continue;
                float ddx = ex[j] - px, ddy = ey[j] - py_;
                float d2 = ddx*ddx + ddy*ddy;
                if (d2 < best) { best = d2; best_j = j; }
            }
            return best_j;
        }
        float px = ex[i], py_ = ey[i];
        int cx = (int)(px / cell); int cy = (int)(py_ / cell);
        if (cx < 0) cx = 0; else if (cx >= ncx) cx = ncx - 1;
        if (cy < 0) cy = 0; else if (cy >= ncy) cy = ncy - 1;
        float best = eat_r * eat_r; int best_j = -1;
        for (int dy = -1; dy <= 1; ++dy) {
            int ny = cy + dy; if (ny < 0 || ny >= ncy) continue;
            for (int dx = -1; dx <= 1; ++dx) {
                int nx = cx + dx; if (nx < 0 || nx >= ncx) continue;
                int c = ny * ncx + nx;
                for (int s = cell_count[c]; s < cell_count[c + 1]; ++s) {
                    int j = sorted_idx[s];
                    if (etype[j] != prey_type) continue;
                    float ddx = ex[j] - px, ddy = ey[j] - py_;
                    float d2 = ddx*ddx + ddy*ddy;
                    if (d2 < best) { best = d2; best_j = j; }
                }
            }
        }
        return best_j;
    }

    float world, cell, vision, eat_r, speed;
    float rabbit_metab, fox_metab, rabbit_move_cost;
    float grass_energy, rabbit_energy_to_fox, repro_threshold, init_energy;
    int n_rabbits0, n_foxes0, n_grass0, grass_max;
    float grass_spawn_rate, max_age;
    int refuge_rabbits, refuge_foxes;
    std::mt19937_64 rng;
    std::uniform_real_distribution<float> dist01{0.f, 1.f};

    int ncx, ncy, ncells;
    int n_rabbits = 0, n_foxes = 0, n_grass = 0;
    int n_active = 0;
    int free_top = 0;
    bool use_grid = true;
    long steps = 0;
    float grass_accum = 0.f;
    uint64_t rstate = 0x9e3779b97f4a7c15ULL;

    std::vector<int8_t> etype;
    std::vector<float> ex, ey, energy, age;
    std::vector<int8_t> dir;
    std::vector<uint64_t> entity_id;
    std::vector<int32_t> free_stack, cell_of, sorted_idx;
    std::vector<int32_t> cell_count, cell_cursor;
    std::vector<int32_t> alist, apos;
    std::vector<uint8_t> dead;
    std::vector<uint8_t> obstacles;
    std::vector<float> astar_g;
    std::vector<int32_t> astar_parent, astar_open;
    std::vector<uint32_t> astar_seen, astar_closed;
    std::vector<int32_t> kill_q;
    std::vector<Birth> birth_q;
    uint64_t next_entity_id = 1;
    uint32_t astar_stamp = 0;
    int last_path_queries = 0, last_path_expansions = 0;
    int last_path_fallbacks = 0, last_invalid_targets = 0;
    int n_agents = 0;
    py::array_t<float> obs_buf;
    py::array_t<int32_t> slot_buf;
    py::array_t<int8_t> type_buf;
    py::array_t<uint64_t> id_buf;
    py::array_t<float> group_buf;
};

PYBIND11_MODULE(eco_engine, m) {
    m.attr("MAX_TOTAL_ENTITIES") = MAX_TOTAL_ENTITIES;
    m.attr("EMPTY")  = EMPTY;
    m.attr("GRASS")  = GRASS;
    m.attr("RABBIT") = RABBIT;
    m.attr("FOX")    = FOX;
    m.attr("AOBS")   = AOBS;
    m.attr("MAX_VIS") = MAX_VIS;
    m.attr("DENSITY_DIM") = DENSITY_DIM;
    m.attr("LOCAL_DIM") = LOCAL_DIM;
    m.attr("GROUP_DIM") = GROUP_DIM;
    m.attr("ASTAR_MAX_EXPANSIONS") = ASTAR_MAX_EXPANSIONS;
    py::class_<EcoEngine>(m, "EcoEngine")
        .def(py::init<float, float, float, float, float, float, float, float,
                      float, float, float, float, int, int, int, int, float,
                      float, int, int, bool, uint64_t>(),
             py::arg("world") = 100.f, py::arg("cell_size") = 4.f,
             py::arg("vision") = 12.f, py::arg("eat_radius") = 1.5f,
             py::arg("move_speed") = 1.0f,
             py::arg("rabbit_metab") = 0.2f, py::arg("fox_metab") = 0.5f,
             py::arg("rabbit_move_cost") = 0.05f,
             py::arg("grass_energy") = 4.0f, py::arg("rabbit_energy_to_fox") = 12.0f,
             py::arg("repro_threshold") = 20.0f, py::arg("init_energy") = 10.0f,
             py::arg("n_rabbits0") = 100, py::arg("n_foxes0") = 20,
             py::arg("n_grass0") = 200, py::arg("grass_max") = 400,
             py::arg("grass_spawn_rate") = 4.0f, py::arg("max_age") = 0.f,
             py::arg("refuge_rabbits") = 0, py::arg("refuge_foxes") = 0,
             py::arg("use_grid") = true, py::arg("seed") = 0)
        .def("reset", &EcoEngine::reset, py::arg("seed") = 0)
        .def("step", &EcoEngine::step, py::arg("actions"), py::arg("use_actions") = false)
        .def("set_world", &EcoEngine::set_world)
        .def("build_agent_obs", &EcoEngine::build_agent_obs)
        .def("agent_obs", &EcoEngine::agent_obs)
        .def("agent_slots", &EcoEngine::agent_slots)
        .def("agent_types", &EcoEngine::agent_types)
        .def("agent_ids", &EcoEngine::agent_ids)
        .def("agent_group_metrics", &EcoEngine::agent_group_metrics)
        .def("types", &EcoEngine::types)
        .def("xs", &EcoEngine::xs)
        .def("ys", &EcoEngine::ys)
        .def("energies", &EcoEngine::energies)
        .def("ids", &EcoEngine::ids)
        .def("clear_obstacles", &EcoEngine::clear_obstacles)
        .def("set_obstacle", &EcoEngine::set_obstacle, py::arg("cx"), py::arg("cy"),
             py::arg("blocked") = true)
        .def("is_obstacle", &EcoEngine::is_obstacle)
        .def("set_position", &EcoEngine::set_position)
        .def("add_pillar", &EcoEngine::add_pillar, py::arg("cx"), py::arg("cy"),
             py::arg("radius"))
        .def("line_of_sight", &EcoEngine::line_of_sight,
             py::arg("x0"), py::arg("y0"), py::arg("x1"), py::arg("y1"))
        .def("slots_visible", &EcoEngine::slots_visible, py::arg("a"), py::arg("b"))
        .def("count_rabbits", &EcoEngine::count_rabbits)
        .def("count_foxes", &EcoEngine::count_foxes)
        .def("count_grass", &EcoEngine::count_grass)
        .def("active_count", &EcoEngine::active_count)
        .def("capacity", &EcoEngine::capacity)
        .def("free_slots", &EcoEngine::free_slots)
        .def("step_count", &EcoEngine::step_count)
        .def("path_queries", &EcoEngine::path_queries)
        .def("path_expansions", &EcoEngine::path_expansions)
        .def("path_fallbacks", &EcoEngine::path_fallbacks)
        .def("invalid_targets", &EcoEngine::invalid_targets)
        .def("current_fox_steering_scale", &EcoEngine::current_fox_steering_scale);
}
