/**
 * @terminus/orchestration — Organization & Capability Directory (SPEC §4, §16.1).
 *
 * Implements federated organization topology, departmental workspaces,
 * persistent operator agents, agent rooms, and deterministic capability resolution
 * without requiring a centralized root agent bottleneck.
 */
import type {
  Organization,
  Department,
  OperatorAgent,
  AgentRoom,
  CapabilityDirectoryEntry,
} from "@terminus/domain";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
  agentRoomSchema,
  capabilityDirectoryEntrySchema,
  departmentSchema,
  operatorAgentSchema,
  organizationSchema,
} from "@terminus/domain";

export interface CapabilityMatchRequest {
  readonly capabilityId: string;
  readonly category?: string;
  readonly resourceDomain?: string;
  readonly requiredAuthority?: readonly string[];
}

export interface CapabilityMatchResult {
  readonly matched: boolean;
  readonly entry: CapabilityDirectoryEntry | null;
  readonly operator: OperatorAgent | null;
  readonly department: Department | null;
  readonly reason: string;
}

export class OrganizationDirectory {
  private readonly organizations = new Map<string, Organization>();
  private readonly departments = new Map<string, Department>();
  private readonly operators = new Map<string, OperatorAgent>();
  private readonly rooms = new Map<string, AgentRoom>();
  private readonly capabilityEntries = new Map<string, CapabilityDirectoryEntry>();

  // Organization operations
  public registerOrganization(org: Organization): void {
    organizationSchema.parse(org);
    this.assertIdentityIsStable(this.organizations, org.id, org, "organization");
    this.organizations.set(org.id, { ...org });
  }

  public getOrganization(id: string): Organization | null {
    const organization = this.organizations.get(id);
    return organization === undefined ? null : { ...organization };
  }

  public listOrganizations(): readonly Organization[] {
    return [...this.organizations.values()].map((organization) => ({ ...organization }));
  }

  // Department operations
  public registerDepartment(dept: Department): void {
    departmentSchema.parse(dept);
    if (!this.organizations.has(dept.organizationId)) {
      throw new NotFoundError("organization", dept.organizationId);
    }
    this.assertIdentityIsStable(this.departments, dept.id, dept, "department");
    this.departments.set(dept.id, { ...dept });
  }

  public getDepartment(id: string): Department | null {
    const department = this.departments.get(id);
    return department === undefined ? null : { ...department };
  }

  public listDepartments(organizationId?: string): readonly Department[] {
    const list = Array.from(this.departments.values());
    if (organizationId) {
      return list.filter((d) => d.organizationId === organizationId).map((department) => ({ ...department }));
    }
    return list.map((department) => ({ ...department }));
  }

  // Operator operations
  public registerOperator(op: OperatorAgent): void {
    operatorAgentSchema.parse(op);
    if (!this.departments.has(op.departmentId)) throw new NotFoundError("department", op.departmentId);
    this.assertIdentityIsStable(this.operators, op.id, op, "operator");
    this.operators.set(op.id, { ...op, capabilityScope: [...op.capabilityScope] });
  }

  public getOperator(id: string): OperatorAgent | null {
    const operator = this.operators.get(id);
    return operator === undefined ? null : { ...operator, capabilityScope: [...operator.capabilityScope] };
  }

  public listOperators(departmentId?: string): readonly OperatorAgent[] {
    const list = Array.from(this.operators.values());
    if (departmentId) {
      return list.filter((op) => op.departmentId === departmentId).map((operator) => ({ ...operator, capabilityScope: [...operator.capabilityScope] }));
    }
    return list.map((operator) => ({ ...operator, capabilityScope: [...operator.capabilityScope] }));
  }

  // Agent Room operations
  public registerRoom(room: AgentRoom): void {
    agentRoomSchema.parse(room);
    const operator = this.operators.get(room.operatorId);
    if (operator === undefined || operator.departmentId !== room.departmentId) {
      throw new ValidationError("Agent room operator must belong to the room department", {
        roomId: room.id,
        operatorId: room.operatorId,
        departmentId: room.departmentId,
      });
    }
    this.assertIdentityIsStable(this.rooms, room.id, room, "agent room");
    this.rooms.set(room.id, {
      ...room,
      activeWorkerIds: [...room.activeWorkerIds],
      specialistIds: [...room.specialistIds],
      reviewerIds: [...room.reviewerIds],
    });
  }

  public getRoom(id: string): AgentRoom | null {
    const room = this.rooms.get(id);
    return room === undefined ? null : this.copyRoom(room);
  }

  public listRooms(departmentId?: string): readonly AgentRoom[] {
    const list = Array.from(this.rooms.values());
    if (departmentId) {
      return list.filter((r) => r.departmentId === departmentId).map((room) => this.copyRoom(room));
    }
    return list.map((room) => this.copyRoom(room));
  }

  // Capability Directory operations
  public registerCapability(entry: CapabilityDirectoryEntry): void {
    capabilityDirectoryEntrySchema.parse(entry);
    const operator = this.operators.get(entry.providerOperatorId);
    if (operator === undefined) {
      throw new NotFoundError("operator", entry.providerOperatorId);
    }
    if (!operator.capabilityScope.includes(entry.capabilityId)) {
      throw new ValidationError(
        "Capability directory entry exceeds the provider operator scope",
        {
          entryId: entry.id,
          capabilityId: entry.capabilityId,
          operatorId: operator.id,
        },
      );
    }
    this.assertIdentityIsStable(
      this.capabilityEntries,
      entry.id,
      entry,
      "capability directory entry",
    );
    this.capabilityEntries.set(entry.id, {
      ...entry,
      authorityRequirement: [...entry.authorityRequirement],
    });
  }

  public listCapabilities(): readonly CapabilityDirectoryEntry[] {
    return [...this.capabilityEntries.values()].map((entry) => this.copyCapability(entry));
  }

  /**
   * Deterministic capability directory lookup.
   * Resolves a capability request to the eligible OperatorAgent and Department.
   */
  public resolveCapability(request: CapabilityMatchRequest): CapabilityMatchResult {
    const entries = [...this.capabilityEntries.values()].sort((left, right) => left.id.localeCompare(right.id));
    for (const entry of entries) {
      if (entry.status !== "AVAILABLE") continue;
      if (entry.capabilityId !== request.capabilityId) continue;
      if (request.category && entry.category !== request.category) continue;
      if (request.resourceDomain && entry.resourceDomain !== request.resourceDomain && entry.resourceDomain !== "*") {
        continue;
      }
      const requesterAuthority = new Set(request.requiredAuthority ?? []);
      if (entry.authorityRequirement.some((required) => !requesterAuthority.has(required))) continue;

      const operator = this.operators.get(entry.providerOperatorId);
      if (!operator || !operator.active) continue;
      if (!operator.capabilityScope.includes(entry.capabilityId)) continue;

      const department = this.departments.get(operator.departmentId);
      if (!department) continue;

      return {
        matched: true,
        entry: this.copyCapability(entry),
        operator: { ...operator, capabilityScope: [...operator.capabilityScope] },
        department: { ...department },
        reason: `Matched capability ${entry.capabilityId} provided by operator ${operator.displayName} in department ${department.displayName}`,
      };
    }

    return {
      matched: false,
      entry: null,
      operator: null,
      department: null,
      reason: `No active provider operator found for capability ${request.capabilityId}`,
    };
  }

  private copyRoom(room: AgentRoom): AgentRoom {
    return {
      ...room,
      activeWorkerIds: [...room.activeWorkerIds],
      specialistIds: [...room.specialistIds],
      reviewerIds: [...room.reviewerIds],
    };
  }

  private copyCapability(entry: CapabilityDirectoryEntry): CapabilityDirectoryEntry {
    return { ...entry, authorityRequirement: [...entry.authorityRequirement] };
  }

  private assertIdentityIsStable<T>(
    entries: ReadonlyMap<string, T>,
    id: string,
    next: T,
    entity: string,
  ): void {
    const existing = entries.get(id);
    if (existing === undefined || JSON.stringify(existing) === JSON.stringify(next)) return;
    throw new ConflictError(
      "ALREADY_EXISTS",
      `${entity} '${id}' is already registered with different content`,
      { entity, id },
    );
  }
}
