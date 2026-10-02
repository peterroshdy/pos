import "@fastify/jwt";
import type { Permission } from "@token-taste/shared";

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: {
      sub: string;
      branchId: string;
      name: string;
      nameAr: string;
      isSuperAdmin: boolean;
      permissions: Permission[];
    };
    user: {
      sub: string;
      branchId: string;
      name: string;
      nameAr: string;
      isSuperAdmin: boolean;
      permissions: Permission[];
    };
  }
}
