import { BarChart3, Headphones, LayoutDashboard, Receipt, Users, UserPlus, Layers, Upload, Repeat, Calculator, Plug } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { NavLink } from "@/components/NavLink";
import { useAuth } from "@/hooks/useAuth";
import { hashUserScope } from "@/services/cohortsCache";
import { prefetchCohortsNav } from "@/hooks/useCohortsCache";
import { cohortsDataSourceMode } from "@/services/cohortsDataSource";
import { loadMaxRenewalColumns } from "@/services/dataSettings";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";

const items = [
  { title: "Dashboard", url: "/", icon: LayoutDashboard, end: true },
  { title: "Transactions", url: "/transactions", icon: Receipt, end: false },
  { title: "Users", url: "/users", icon: Users, end: false },
  { title: "Leads", url: "/leads", icon: UserPlus, end: false },
  { title: "Cohorts", url: "/cohorts", icon: Layers, end: false },
  { title: "FB-Analytics", url: "/fb-analytics", icon: BarChart3, end: false },
  { title: "Integrations", url: "/integrations", icon: Plug, end: false },
  { title: "Support", url: "/support", icon: Headphones, end: false },
  { title: "Forecasting", url: "/forecasting", icon: Calculator, end: false },
  { title: "Subscriptions", url: "/subscriptions", icon: Repeat, end: false },
  { title: "Import data", url: "/import", icon: Upload, end: false },
];

export function AppSidebar() {
  const { state } = useSidebar();
  const collapsed = state === "collapsed";
  const queryClient = useQueryClient();
  const { user } = useAuth();

  // Warm the Cohorts cache when the user shows intent to navigate there. Only in
  // ClickHouse mode; respects staleTime (no duplicate when already fresh).
  const prefetchCohorts = () => {
    if (cohortsDataSourceMode() !== "clickhouse") return;
    prefetchCohortsNav(queryClient, hashUserScope(user?.id), loadMaxRenewalColumns());
  };

  return (
    <Sidebar collapsible="icon" className="border-r border-sidebar-border">
      <SidebarHeader className="border-b border-sidebar-border">
        <div className="flex items-center gap-2 px-2 py-3">
          <div className="relative flex h-8 w-8 items-center justify-center overflow-hidden rounded-lg bg-gradient-to-br from-primary via-primary-glow to-accent text-primary-foreground shadow-sm">
            <span className="text-sm font-bold leading-none">S</span>
            <span className="absolute bottom-1.5 right-1.5 h-1 w-1 rounded-full bg-primary-foreground/90" />
            <span className="absolute bottom-1.5 right-3 h-2 w-1 rounded-full bg-primary-foreground/75" />
            <span className="absolute bottom-1.5 right-[1.125rem] h-3 w-1 rounded-full bg-primary-foreground/60" />
          </div>
          {!collapsed && (
            <div className="flex flex-col">
              <span className="text-sm font-semibold leading-none text-foreground">Subengine</span>
              <span className="text-xs text-muted-foreground leading-none mt-1">Analytics engine</span>
            </div>
          )}
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Workspace</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {items.map((item) => (
                <SidebarMenuItem key={item.title}>
                  <SidebarMenuButton asChild tooltip={item.title}>
                    <NavLink
                      to={item.url}
                      end={item.end}
                      onMouseEnter={item.url === "/cohorts" ? prefetchCohorts : undefined}
                      onFocus={item.url === "/cohorts" ? prefetchCohorts : undefined}
                      className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                      activeClassName="bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                    >
                      <item.icon className="h-4 w-4" />
                      {!collapsed && <span>{item.title}</span>}
                    </NavLink>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  );
}
