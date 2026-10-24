from ga_harness.plugin_manager import PluginManager


def apply(ctx, config):
    catalog = ctx.get("plugin.catalog")
    ctx.provide("plugin.manager", PluginManager(ctx, catalog["preferences"], catalog["tree"]))
