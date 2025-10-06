from setuptools import setup, find_packages

setup(
    name="e2e_test_kvs_lib",
    version="0.1.0",
    packages=find_packages(),
    install_requires=[
        'click>=8.0',
    ],
    entry_points={
        'console_scripts': [
            'kvs-server=src.main:start_server',
        ],
    },
)