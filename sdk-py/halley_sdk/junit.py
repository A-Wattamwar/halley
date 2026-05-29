"""
JUnit XML writer for halley ci results.

Produces a JUnit XML file compatible with CI systems (GitHub Actions,
Jenkins, etc.). One <testsuite> per fixture, one <testcase> per invariant.
"""

import xml.etree.ElementTree as ET
from typing import Any


def write_junit_xml(
    results: list[dict[str, Any]],
    output_path: str,
) -> None:
    """Write JUnit XML from CI results.

    Args:
        results: List of dicts with keys:
            fixture_slug, invariant_name, passed, message, time_s
        output_path: Where to write the XML file.
    """
    # Group by fixture.
    suites: dict[str, list[dict]] = {}
    for r in results:
        slug = r["fixture_slug"]
        suites.setdefault(slug, []).append(r)

    root = ET.Element("testsuites")

    total_tests = 0
    total_failures = 0

    for slug, cases in suites.items():
        suite = ET.SubElement(root, "testsuite", name=slug)
        failures = sum(1 for c in cases if not c["passed"])
        suite.set("tests", str(len(cases)))
        suite.set("failures", str(failures))
        suite.set("errors", "0")

        total_tests += len(cases)
        total_failures += failures

        for case in cases:
            tc = ET.SubElement(
                suite,
                "testcase",
                name=case["invariant_name"],
                classname=slug,
            )
            if "time_s" in case:
                tc.set("time", f"{case['time_s']:.3f}")
            if not case["passed"]:
                failure = ET.SubElement(tc, "failure", message=case["message"])
                failure.text = case["message"]

    root.set("tests", str(total_tests))
    root.set("failures", str(total_failures))

    tree = ET.ElementTree(root)
    ET.indent(tree, space="  ")
    tree.write(output_path, encoding="unicode", xml_declaration=True)
